/* global module */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MLCCaptureUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function splitNonEmptyLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function countMatches(text, regex) {
    if (!text) return 0;
    const matches = String(text).match(regex);
    return matches ? matches.length : 0;
  }

  function countUrlLike(text) {
    return countMatches(text, /\bhttps?:\/\/\S+|\bwww\.\S+/gi);
  }

  function countDomainLike(text) {
    // Rough heuristic for domains in reference lists; intentionally conservative.
    return countMatches(text, /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi);
  }

  function countSentenceEndPunct(text) {
    return countMatches(text, /[.!?](?:\s|$)/g);
  }

  function countCodeFences(text) {
    return countMatches(text, /```/g);
  }

  function analyzeText(text) {
    const raw = String(text || '').trim();
    const normalized = raw.replace(/\r/g, '');
    const lines = splitNonEmptyLines(normalized);
    const wordCount = raw ? raw.split(/\s+/).filter(Boolean).length : 0;
    const plusLineCount = lines.filter(line => /^\+\d+$/.test(line)).length;
    const bulletLikeCount = lines.filter(line => /^([-*•]\s+|\d+[.)]\s+)/.test(line)).length;
    const urlCount = countUrlLike(raw);
    const domainCount = countDomainLike(raw);
    const sentenceEndPunctCount = countSentenceEndPunct(raw);
    const codeFenceCount = countCodeFences(raw);
    const avgLineLen = lines.length
      ? (lines.reduce((sum, line) => sum + line.length, 0) / lines.length)
      : 0;
    const uniqueLineRatio = lines.length ? (new Set(lines).size / lines.length) : 1;
    const firstLine = lines[0] || '';
    const startsWithSourcesHeading = /^(sources?|references?|citations?)\b[:\s-]*/i.test(firstLine);
    const hasSourcesHeading = lines.some(line => /^(sources?|references?|citations?)\b[:\s-]*/i.test(line));
    const urlishLineCount = lines.filter(line => /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/i.test(line)).length;

    return {
      raw,
      normalized,
      lines,
      lineCount: lines.length,
      wordCount,
      plusLineCount,
      bulletLikeCount,
      urlCount,
      domainCount,
      urlishLineCount,
      sentenceEndPunctCount,
      codeFenceCount,
      avgLineLen,
      uniqueLineRatio,
      startsWithSourcesHeading,
      hasSourcesHeading
    };
  }

  function looksLikeReferenceList(text, options) {
    const analysis = analyzeText(text);
    if (!analysis.raw) return false;

    const { lineCount, wordCount, codeFenceCount, sentenceEndPunctCount } = analysis;
    const urlishRatio = analysis.urlishLineCount / Math.max(1, lineCount);
    const bulletRatio = analysis.bulletLikeCount / Math.max(1, lineCount);

    // If it contains real prose or code blocks, it's usually not a sources-only block.
    if (sentenceEndPunctCount >= 2) return false;
    if (codeFenceCount >= 1 && urlishRatio < 0.3) return false;

    // Strong signals.
    if (analysis.startsWithSourcesHeading && lineCount >= 3 && sentenceEndPunctCount === 0) {
      // Some UIs render sources as title lists without explicit URLs; accept bullet/title structure too.
      if (urlishRatio >= 0.2 || bulletRatio >= 0.4 || analysis.plusLineCount >= 1) return true;
    }
    if (analysis.plusLineCount >= 1 && lineCount >= 4 && sentenceEndPunctCount === 0) return true;

    // Weaker, structure-based signals.
    if (lineCount >= 4 && urlishRatio >= 0.6 && sentenceEndPunctCount === 0) return true;
    if (lineCount >= 6 && bulletRatio >= 0.6 && urlishRatio >= 0.3 && sentenceEndPunctCount === 0) return true;
    if (lineCount >= 8 && urlishRatio >= 0.5 && analysis.avgLineLen <= 80 && sentenceEndPunctCount === 0) return true;

    // Provider-specific looseness (future extension point).
    if (options?.provider === 'chatgpt' && analysis.hasSourcesHeading && lineCount >= 4 && sentenceEndPunctCount === 0) {
      if (urlishRatio >= 0.3 || bulletRatio >= 0.4 || analysis.plusLineCount >= 1) return true;
    }

    // Avoid flagging tiny snippets.
    if (wordCount < 12) return false;

    return false;
  }

  function scoreTextCandidate(text, options) {
    const analysis = analyzeText(text);
    if (!analysis.raw) {
      return { score: -Infinity, analysis, isReferenceList: false };
    }

    const isReferenceList = looksLikeReferenceList(text, options);

    // Base: reward meaningful length but with diminishing returns.
    const lengthScore = Math.min(30, Math.log2(analysis.wordCount + 1) * 8);
    const punctScore = Math.min(12, analysis.sentenceEndPunctCount * 2);
    const structureScore = Math.min(8, Math.max(0, analysis.lineCount - 1));
    const codeScore = analysis.codeFenceCount ? 4 : 0;

    // Penalties for reference-like structure.
    const urlPenalty = Math.min(30, analysis.urlCount * 2) + Math.min(20, analysis.domainCount);
    const bulletPenalty = analysis.bulletLikeCount >= 8 && analysis.sentenceEndPunctCount === 0 ? 8 : 0;
    const referencePenalty = isReferenceList ? 60 : 0;

    const score = lengthScore + punctScore + structureScore + codeScore - urlPenalty - bulletPenalty - referencePenalty;
    return { score, analysis, isReferenceList };
  }

  function rankTextCandidates(candidates, options) {
    const texts = Array.isArray(candidates) ? candidates : [];
    const ranked = texts.map((text, index) => {
      const result = scoreTextCandidate(text, options);
      return {
        index,
        score: result.score,
        isReferenceList: result.isReferenceList,
        analysis: result.analysis
      };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

    return ranked;
  }

  function chooseBestTextCandidate(candidates, options) {
    const ranked = rankTextCandidates(candidates, options);
    const best = ranked[0] || null;
    return {
      bestIndex: best ? best.index : -1,
      best: best,
      ranked
    };
  }

  return {
    normalizeWhitespace,
    analyzeText,
    looksLikeReferenceList,
    scoreTextCandidate,
    rankTextCandidates,
    chooseBestTextCandidate
  };
});
