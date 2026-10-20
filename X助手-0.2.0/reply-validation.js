function hasMeaningfulReplyText(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || /^\[skip\]$/i.test(text)) return false;
  // Require at least one letter or number. This rejects punctuation-only and
  // emoji-only outputs while keeping short Chinese, English, and numeric replies.
  return /[\p{L}\p{N}]/u.test(text);
}
