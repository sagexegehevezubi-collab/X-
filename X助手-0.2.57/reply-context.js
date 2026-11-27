// Extract only the visible shape of an X post. Media itself is never sent to the model.
function replyContextText(element) {
  return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
}

function replyContextIsOuterPostNode(post, node) {
  let parent = node?.parentElement;
  while (parent && parent !== post) {
    if (parent.matches?.('article,[data-testid="tweet"]')) return false;
    if (parent.matches?.('[role="link"],a[href*="/status/"]') &&
      parent.querySelector?.('[data-testid="User-Name"],[data-testid="tweetText"]')) return false;
    parent = parent.parentElement;
  }
  return parent === post;
}

function getReplyPostContext(article) {
  const context = { video: false, live: false, audio: false, image: false, poll: false,
    quoted: false, quotedText: "", replyContext: "", externalLink: false, linkCardText: "" };
  if (!article?.querySelector || !article?.querySelectorAll) return context;
  const has = (selector) => { try { return Boolean(article.querySelector(selector)); } catch { return false; } };
  const nodes = (selector) => { try { return [...article.querySelectorAll(selector)]; } catch { return []; } };

  context.live = nodes('a[href*="/i/spaces/"], [data-testid*="space"], [aria-label]').some((node) =>
    /\/i\/spaces\//i.test(node.getAttribute?.("href") || "") ||
    /收听直播|正在直播|live audio|listen live|space is live/i.test(node.getAttribute?.("aria-label") || replyContextText(node)));
  const labeledMedia = nodes('[aria-label]').map((node) => node.getAttribute?.("aria-label") || "");
  context.video = has('video,[data-testid*="videoPlayer"],[data-testid*="videoComponent"],[data-testid="tweetVideo"]') ||
    labeledMedia.some((label) => /播放视频|视频播放器|play video|video player/i.test(label));
  context.audio = has('audio,[data-testid*="audioPlayer"],[data-testid*="audioSpace"]') ||
    labeledMedia.some((label) => /音频播放器|播放音频|audio player|voice message/i.test(label));
  context.image = has('[data-testid="tweetPhoto"],[data-testid*="imageViewer"]');
  context.poll = has('[data-testid*="poll"],[role="radio"]');

  const quoteTexts = nodes('[data-testid="tweetText"]')
    .filter((node) => !replyContextIsOuterPostNode(article, node))
    .map(replyContextText).filter(Boolean);
  context.quotedText = quoteTexts.join("\n").slice(0, 1600);
  context.quoted = quoteTexts.length > 0 || nodes('[data-testid="User-Name"]').some((node) =>
    !replyContextIsOuterPostNode(article, node));
  const socialContext = nodes('[data-testid="socialContext"]')
    .find((node) => replyContextIsOuterPostNode(article, node));
  context.replyContext = replyContextText(socialContext).slice(0, 180);
  context.replyPost = /replying to|replied to|回复了|回复给/i.test(context.replyContext);

  const cards = nodes('[data-testid="card.wrapper"]');
  context.linkCardText = cards.map(replyContextText).filter(Boolean).join("\n").slice(0, 800);
  context.externalLink = nodes('a[href]').some((node) => {
    if (!replyContextIsOuterPostNode(article, node)) return false;
    const href = String(node.getAttribute?.("href") || "");
    return /^https?:/i.test(href) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(href);
  });
  return context;
}
