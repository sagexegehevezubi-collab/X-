function hasMeaningfulReplyText(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || /^\[skip\]$/i.test(text)) return false;
  // Require at least one letter or number. This rejects punctuation-only and
  // emoji-only outputs while keeping short Chinese, English, and numeric replies.
  return /[\p{L}\p{N}]/u.test(text);
}

// A safety refusal is an instruction to skip the post, never a reply draft.
// Keep this focused on refusal language plus a safety context so ordinary
// comments containing words such as “不能” are unaffected.
function isModelRefusalReply(value) {
  const text = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text || /^\[skip\]$/i.test(text)) return false;
  const refusal = /(?:不能|无法|不便|拒绝|不可以|不可|不能够|无法协助|无法提供|不能提供|不能帮助|不予|不支持|can't|cannot|unable|won't|will not|decline|refuse|not able)/i;
  const safety = /(?:色情|淫秽|黄色|露骨|裸体|性内容|违法|违规|有害|危险|仇恨|暴力|谣言|虚假信息|垃圾|不实|spam|misinformation|disinformation|explicit|sexual|illegal|harmful|unsafe|policy|guidelines|safety)/i;
  const refusalOpening = /^(?:抱歉|很抱歉|对不起|不好意思|作为(?:一个)?(?:人工智能|AI)|我是(?:一个)?AI|sorry|i(?:['’]m| am) sorry|as an ai|i cannot|i can't|i am unable|i'm unable)/i;
  return (refusalOpening.test(text) && refusal.test(text)) ||
    (refusal.test(text) && safety.test(text) && text.length >= 10);
}
