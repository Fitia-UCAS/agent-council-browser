"""
Run nanochat training on Modal.

Goals:
- Smoke test: tiny d=1 run on 1xA100 with 2 dataset shards.
- Full run: execute upstream speedrun.sh on 8xH100 with artifacts persisted to a Modal Volume.

The Modal image is built to closely match speedrun.sh (uv + lockfile, rustbpe via maturin).
All training artifacts (dataset shards, tokenizer, checkpoints, reports, logs) are written into
the mounted volume so they persist across runs.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

import modal


# ---------------------------------------------------------------------------
# Config

APP_NAME = "nanochat"
VOLUME_NAME = "nanochat-cache"
# Optional: attach a Modal Secret containing WANDB_API_KEY.
# Set this locally when launching, e.g.:
#   NANOCHAT_WANDB_SECRET_NAME=wandb-secret modal run modal_nanochat.py --mode speedrun --wandb-run myrun
WANDB_SECRET_NAME = os.environ.get("NANOCHAT_WANDB_SECRET_NAME", "wandb-secret").strip()
WANDB_SECRETS = [modal.Secret.from_name(WANDB_SECRET_NAME)] if WANDB_SECRET_NAME else []

REPO_DIR = Path("/root/nanochat")
VENV_BIN = REPO_DIR / ".venv" / "bin"
PYTHON = str(VENV_BIN / "python")
TORCHRUN = str(VENV_BIN / "torchrun")

CACHE_MOUNT = Path("/cache")
RUNS_ROOT = CACHE_MOUNT / "nanochat_runs"
ASSETS_ROOT = CACHE_MOUNT / "nanochat_assets"
EVAL_BUNDLE_ZIP = ASSETS_ROOT / "eval_bundle.zip"
IDENTITY_CONVERSATIONS_JSONL = ASSETS_ROOT / "identity_conversations.jsonl"
IDENTITY_CONVERSATIONS_JSONL_ZIP = ASSETS_ROOT / "identity_conversations.jsonl.zip"


def _ignore_matcher() -> modal.FilePatternMatcher:
    # Keep uploads small and deterministic: never ship local venvs/git metadata/targets.
    return modal.FilePatternMatcher(
        ".git",
        ".git/**",
        ".venv",
        ".venv/**",
        "**/__pycache__/**",
        "**/*.pyc",
        ".pytest_cache/**",
        "rustbpe/target/**",
    )


app = modal.App(APP_NAME)
vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


# ---------------------------------------------------------------------------
# Image (uv + rustbpe), with local code synced at container start (copy=False)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "bash",
        "ca-certificates",
        "curl",
        "git",
        "build-essential",
        "pkg-config",
        "libssl-dev",
        "python3-dev",
    )
    .pip_install("uv")
    # Only bake in the pieces needed to build the environment (fast rebuilds).
    .add_local_file("pyproject.toml", remote_path=str(REPO_DIR / "pyproject.toml"), copy=True)
    .add_local_file("uv.lock", remote_path=str(REPO_DIR / "uv.lock"), copy=True)
    .add_local_file("README.md", remote_path=str(REPO_DIR / "README.md"), copy=True)
    .add_local_dir("rustbpe", remote_path=str(REPO_DIR / "rustbpe"), copy=True, ignore=modal.FilePatternMatcher("target/**"))
    .workdir(str(REPO_DIR))
    .env(
        {
            "CARGO_HOME": "/root/.cargo",
            "RUSTUP_HOME": "/root/.rustup",
            # Ensure both uv (pip) and cargo are on PATH.
            "PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PYTHONUNBUFFERED": "1",
        }
    )
    .run_commands(
        "uv venv",
        "uv sync --extra gpu",
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
        "bash -lc 'source $HOME/.cargo/env && uv run maturin develop --release --manifest-path rustbpe/Cargo.toml'",
        "bash -lc '. .venv/bin/activate && python -c \"import rustbpe; import torch; print(torch.__version__)\"'",
    )
    # Sync your local repo into the container at startup for fast iteration.
    .add_local_dir(".", remote_path=str(REPO_DIR), copy=False, ignore=_ignore_matcher())
)


# ---------------------------------------------------------------------------
# Helpers


def _run_dir(run_id: str) -> Path:
    if not run_id or "/" in run_id:
        raise ValueError("run_id must be a non-empty name without '/'")
    return RUNS_ROOT / run_id


def _base_env(*, run_dir: Path, wandb_run: str | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = "1"
    env["NANOCHAT_BASE_DIR"] = str(run_dir)
    env["PYTHONUNBUFFERED"] = "1"
    # Prefer the image-built venv for all subprocesses.
    env["PATH"] = f"{VENV_BIN}:{env.get('PATH', '')}"
    if wandb_run is not None:
        # W&B is optional but Modal runs are non-interactive (no TTY), so if a user
        # passes a non-"dummy" run name without an API key, wandb will crash.
        # In that situation, force-disable W&B to keep the run moving.
        has_wandb_key = bool(env.get("WANDB_API_KEY"))
        if wandb_run == "dummy" or not has_wandb_key:
            env.setdefault("WANDB_MODE", "disabled")
            env.setdefault("WANDB_SILENT", "true")
        env["WANDB_RUN"] = wandb_run
    return env


def _assert_runtime_layout() -> None:
    missing = []
    if not REPO_DIR.exists():
        missing.append(str(REPO_DIR))
    if not Path(PYTHON).exists():
        missing.append(PYTHON)
    if not Path(TORCHRUN).exists():
        missing.append(TORCHRUN)
    if missing:
        raise RuntimeError(
            "Missing expected paths in container: "
            + ", ".join(missing)
            + ". The Modal image may need a rebuild."
        )


def _run(cmd: list[str], *, env: dict[str, str], cwd: Path, log_path: Path | None = None) -> None:
    printable = shlex.join(cmd)
    print(f"\n$ {printable}")
    cwd.mkdir(parents=True, exist_ok=True)

    if log_path is None:
        subprocess.run(cmd, cwd=str(cwd), env=env, check=True)
        return

    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8", buffering=1) as log_f:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="")
            log_f.write(line)
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"Command failed (exit={rc}): {printable}. Log: {log_path}")


def _maybe_run(cmd: list[str], *, env: dict[str, str], cwd: Path, log_path: Path | None = None) -> None:
    try:
        _run(cmd, env=env, cwd=cwd, log_path=log_path)
    except FileNotFoundError as e:
        print(f"Skipping (not found): {cmd[0]} ({e})")


def _ensure_speedrun_cache_symlink(run_dir: Path) -> None:
    """
    speedrun.sh hardcodes NANOCHAT_BASE_DIR=$HOME/.cache/nanochat.
    To keep speedrun.sh unmodified and still persist artifacts, we create:
      /root/.cache/nanochat -> /cache/nanochat_runs/<run_id>
    """
    home_cache = Path("/root/.cache")
    home_cache.mkdir(parents=True, exist_ok=True)
    link_path = home_cache / "nanochat"
    target = run_dir
    target.mkdir(parents=True, exist_ok=True)

    if link_path.is_symlink():
        if link_path.resolve() == target.resolve():
            return
        link_path.unlink()
    elif link_path.exists():
        if link_path.is_dir():
            shutil.rmtree(link_path)
        else:
            link_path.unlink()

    link_path.symlink_to(target, target_is_directory=True)


def _print_artifacts(run_dir: Path) -> None:
    print("\nArtifacts (in the persisted Modal Volume):")
    for rel in ["report", "tokenizer", "base_data", "tokenized_data", "base_checkpoints", "logs"]:
        p = run_dir / rel
        if p.exists():
            try:
                count = sum(1 for _ in p.rglob("*"))
            except Exception:
                count = -1
            print(f"- {p} ({'unknown' if count < 0 else count} items)")
        else:
            print(f"- {p} (missing)")

    print("\nStatic assets (in the persisted Modal Volume):")
    for p in [EVAL_BUNDLE_ZIP, IDENTITY_CONVERSATIONS_JSONL, IDENTITY_CONVERSATIONS_JSONL_ZIP]:
        if p.exists():
            size = p.stat().st_size
            print(f"- {p} ({size} bytes)")
        else:
            print(f"- {p} (missing)")


def _seed_offline_assets(run_dir: Path) -> None:
    """
    Optionally seed files needed by speedrun.sh from the persistent Volume, to avoid
    network downloads when upstream URLs are unavailable.

    Expected layout in the volume mount:
      /cache/nanochat_assets/eval_bundle.zip
      /cache/nanochat_assets/identity_conversations.jsonl
    """
    run_dir.mkdir(parents=True, exist_ok=True)

    # Seed CORE eval bundle: base_eval.py downloads this only if eval_bundle/ is missing.
    eval_bundle_dir = run_dir / "eval_bundle"
    if not eval_bundle_dir.exists() and EVAL_BUNDLE_ZIP.exists():
        import tempfile
        import zipfile

        print(f"Seeding CORE eval bundle from {EVAL_BUNDLE_ZIP} ...")
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(EVAL_BUNDLE_ZIP, "r") as zip_ref:
                zip_ref.extractall(tmpdir)
            extracted = Path(tmpdir) / "eval_bundle"
            if not extracted.exists():
                raise RuntimeError(
                    f"Expected eval_bundle/ directory inside {EVAL_BUNDLE_ZIP}, but it was not found."
                )
            shutil.move(str(extracted), str(eval_bundle_dir))
        print(f"Placed eval bundle at {eval_bundle_dir}")

    # Seed identity conversations: speedrun.sh downloads this to $NANOCHAT_BASE_DIR/identity_conversations.jsonl
    dest_identity = run_dir / "identity_conversations.jsonl"
    if not dest_identity.exists():
        if IDENTITY_CONVERSATIONS_JSONL.exists():
            print(f"Seeding identity conversations from {IDENTITY_CONVERSATIONS_JSONL} ...")
            shutil.copy2(IDENTITY_CONVERSATIONS_JSONL, dest_identity)
            print(f"Placed identity conversations at {dest_identity}")
        elif IDENTITY_CONVERSATIONS_JSONL_ZIP.exists():
            import zipfile

            print(f"Seeding identity conversations from {IDENTITY_CONVERSATIONS_JSONL_ZIP} ...")
            with zipfile.ZipFile(IDENTITY_CONVERSATIONS_JSONL_ZIP, "r") as zip_ref:
                names = zip_ref.namelist()
                if "identity_conversations.jsonl" in names:
                    zip_ref.extract("identity_conversations.jsonl", run_dir)
                elif len(names) == 1 and names[0].endswith(".jsonl"):
                    zip_ref.extract(names[0], run_dir)
                    (run_dir / names[0]).rename(dest_identity)
                else:
                    raise RuntimeError(
                        f"Unexpected contents in {IDENTITY_CONVERSATIONS_JSONL_ZIP}: {names}. "
                        "Expected identity_conversations.jsonl"
                    )
            if not dest_identity.exists():
                raise RuntimeError(f"Failed to extract identity_conversations.jsonl from {IDENTITY_CONVERSATIONS_JSONL_ZIP}")
            print(f"Placed identity conversations at {dest_identity}")


# ---------------------------------------------------------------------------
# Remote functions


@app.function(
    image=image,
    gpu="A100-40GB",
    volumes={str(CACHE_MOUNT): vol},
    secrets=WANDB_SECRETS,
    timeout=15 * 60,
    max_containers=1,
)
def preflight_a100(run_id: str = "preflight-a100") -> None:
    _assert_runtime_layout()
    run_dir = _run_dir(run_id)
    env = _base_env(run_dir=run_dir, wandb_run="dummy")
    log_path = run_dir / "logs" / "preflight_a100.log"

    _maybe_run(["nvidia-smi"], env=env, cwd=REPO_DIR, log_path=log_path)
    _run(
        [
            PYTHON,
            "-c",
            (
                "import torch, rustbpe; "
                "print('torch', torch.__version__); "
                "print('cuda_available', torch.cuda.is_available()); "
                "print('device_count', torch.cuda.device_count()); "
                "print([torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())])"
            ),
        ],
        env=env,
        cwd=REPO_DIR,
        log_path=log_path,
    )
    vol.commit()
    _print_artifacts(run_dir)


@app.function(
    image=image,
    gpu="H100:8",
    volumes={str(CACHE_MOUNT): vol},
    secrets=WANDB_SECRETS,
    timeout=15 * 60,
    max_containers=1,
)
def preflight_h100_8(run_id: str = "preflight-h100x8") -> None:
    _assert_runtime_layout()
    run_dir = _run_dir(run_id)
    env = _base_env(run_dir=run_dir, wandb_run="dummy")
    log_path = run_dir / "logs" / "preflight_h100x8.log"

    _maybe_run(["nvidia-smi"], env=env, cwd=REPO_DIR, log_path=log_path)
    _run(
        [
            PYTHON,
            "-c",
            (
                "import torch, rustbpe; "
                "assert torch.cuda.is_available(); "
                "n=torch.cuda.device_count(); "
                "print('torch', torch.__version__); "
                "print('device_count', n); "
                "assert n==8, f'Expected 8 GPUs, saw {n}'; "
                "print([torch.cuda.get_device_name(i) for i in range(n)])"
            ),
        ],
        env=env,
        cwd=REPO_DIR,
        log_path=log_path,
    )
    vol.commit()
    _print_artifacts(run_dir)


@app.function(
    image=image,
    gpu="A100-40GB",
    volumes={str(CACHE_MOUNT): vol},
    secrets=WANDB_SECRETS,
    timeout=2 * 60 * 60,
    max_containers=1,
)
def smoke_run(
    run_id: str = "smoke",
    shards: int = 2,
    depth: int = 1,
    tokenizer_max_chars: int = 5_000_000,
    tokenizer_vocab_size: int = 8192,
    max_seq_len: int = 128,
    device_batch_size: int = 4,
    total_batch_size: int = 512,
    num_iterations: int = 20,
    eval_every: int = 10,
    eval_tokens: int = 2048,
    split_tokens: int = 2048,
    wandb_run: str = "dummy",
    skip_tok_eval: bool = False,
) -> None:
    """
    Tiny end-to-end run that exercises:
    dataset download -> tokenizer train/save -> torchrun base_train -> base_loss.
    """
    _assert_runtime_layout()
    if shards < 2:
        raise ValueError("shards must be >= 2 (last shard is used for val split)")
    run_dir = _run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    env = _base_env(run_dir=run_dir, wandb_run=wandb_run)
    log_path = run_dir / "logs" / "smoke.log"

    try:
        _run([PYTHON, "-m", "nanochat.report", "reset"], env=env, cwd=REPO_DIR, log_path=log_path)
        _run([PYTHON, "-m", "nanochat.dataset", "-n", str(shards)], env=env, cwd=REPO_DIR, log_path=log_path)
        vol.commit()

        _run(
            [
                PYTHON,
                "-m",
                "scripts.tok_train",
                f"--max_chars={tokenizer_max_chars}",
                f"--vocab_size={tokenizer_vocab_size}",
            ],
            env=env,
            cwd=REPO_DIR,
            log_path=log_path,
        )
        if not skip_tok_eval:
            _run([PYTHON, "-m", "scripts.tok_eval"], env=env, cwd=REPO_DIR, log_path=log_path)
        vol.commit()

        _run(
            [
                TORCHRUN,
                "--standalone",
                "--nproc_per_node=1",
                "-m",
                "scripts.base_train",
                "--",
                f"--depth={depth}",
                f"--run={wandb_run}",
                f"--max_seq_len={max_seq_len}",
                f"--device_batch_size={device_batch_size}",
                f"--total_batch_size={total_batch_size}",
                f"--num_iterations={num_iterations}",
                f"--eval_every={eval_every}",
                f"--eval_tokens={eval_tokens}",
                "--core_metric_every=-1",
                "--save_every=-1",
            ],
            env=env,
            cwd=REPO_DIR,
            log_path=log_path,
        )
        vol.commit()

        _run(
            [
                TORCHRUN,
                "--standalone",
                "--nproc_per_node=1",
                "-m",
                "scripts.base_loss",
                "--",
                f"--device_batch_size={device_batch_size}",
                f"--split_tokens={split_tokens}",
            ],
            env=env,
            cwd=REPO_DIR,
            log_path=log_path,
        )
        vol.commit()

        _run([PYTHON, "-m", "nanochat.report", "generate"], env=env, cwd=REPO_DIR, log_path=log_path)
        local_report = REPO_DIR / "report.md"
        if local_report.exists():
            shutil.copy2(local_report, run_dir / "report.md")
        vol.commit()
    finally:
        # Best-effort: persist anything that was produced before an error.
        try:
            vol.commit()
        except Exception as e:
            print(f"Volume commit failed in finally: {e}")

    _print_artifacts(run_dir)


@app.function(
    image=image,
    gpu="H100:8",
    volumes={str(CACHE_MOUNT): vol},
    secrets=WANDB_SECRETS,
    timeout=8 * 60 * 60,
    max_containers=1,
)
def speedrun_h100_8(run_id: str = "speedrun", wandb_run: str = "dummy") -> None:
    """
    Runs `bash speedrun.sh` (unmodified) on a single 8xH100 node.
    Persists ~/.cache/nanochat into the Modal Volume via a symlink.
    """
    _assert_runtime_layout()
    run_dir = _run_dir(run_id)
    env = _base_env(run_dir=run_dir, wandb_run=wandb_run)
    log_path = run_dir / "logs" / "speedrun_h100x8.log"

    _ensure_speedrun_cache_symlink(run_dir)
    _seed_offline_assets(run_dir)

    try:
        # speedrun.sh intentionally doesn't `set -e`, but in batch/remote contexts it's
        # more useful to fail fast (otherwise later stages error with missing checkpoints).
        _run(["bash", "-e", "speedrun.sh"], env=env, cwd=REPO_DIR, log_path=log_path)
        # speedrun.sh copies report.md to the CWD for convenience; store a copy in the run dir too.
        local_report = REPO_DIR / "report.md"
        if local_report.exists():
            shutil.copy2(local_report, run_dir / "report.md")
    finally:
        try:
            vol.commit()
        except Exception as e:
            print(f"Volume commit failed in finally: {e}")

    _print_artifacts(run_dir)


@app.function(image=image, volumes={str(CACHE_MOUNT): vol}, timeout=5 * 60)
def list_artifacts(run_id: str = "smoke") -> None:
    run_dir = _run_dir(run_id)
    if not run_dir.exists():
        print(f"Run dir does not exist: {run_dir}")
        return
    _print_artifacts(run_dir)


# ---------------------------------------------------------------------------
# Local entrypoint


@app.local_entrypoint()
def main(
    mode: str = "smoke",
    run_id: str = "smoke",
    wandb_run: str = "dummy",
    shards: int = 2,
    depth: int = 1,
    tokenizer_max_chars: int = 5_000_000,
    tokenizer_vocab_size: int = 8192,
    max_seq_len: int = 128,
    device_batch_size: int = 4,
    total_batch_size: int = 512,
    num_iterations: int = 20,
    eval_every: int = 10,
    eval_tokens: int = 2048,
    split_tokens: int = 2048,
    skip_tok_eval: bool = False,
) -> None:
    """
    Examples:
      modal run modal_nanochat.py --mode preflight-a100
      modal run modal_nanochat.py --mode smoke --run-id smoke --depth 1 --shards 2
      modal run modal_nanochat.py --mode speedrun --run-id speedrun-d20 --wandb-run dummy
      modal run modal_nanochat.py --mode list --run-id smoke
    """
    if mode == "preflight-a100":
        preflight_a100.remote(run_id=run_id)
    elif mode == "preflight-h100x8":
        preflight_h100_8.remote(run_id=run_id)
    elif mode == "smoke":
        smoke_run.remote(
            run_id=run_id,
            shards=shards,
            depth=depth,
            tokenizer_max_chars=tokenizer_max_chars,
            tokenizer_vocab_size=tokenizer_vocab_size,
            max_seq_len=max_seq_len,
            device_batch_size=device_batch_size,
            total_batch_size=total_batch_size,
            num_iterations=num_iterations,
            eval_every=eval_every,
            eval_tokens=eval_tokens,
            split_tokens=split_tokens,
            wandb_run=wandb_run,
            skip_tok_eval=skip_tok_eval,
        )
    elif mode == "speedrun":
        speedrun_h100_8.remote(run_id=run_id, wandb_run=wandb_run)
    elif mode == "list":
        list_artifacts.remote(run_id=run_id)
    else:
        raise ValueError(
            f"Unknown mode: {mode}. Supported: preflight-a100, preflight-h100x8, smoke, speedrun, list"
        )
