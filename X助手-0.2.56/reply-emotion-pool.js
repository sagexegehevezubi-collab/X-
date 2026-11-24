// AI 回复的夸张情绪开头词池。按顺序轮换，序号保存在 chrome.storage.local。
const REPLY_EMOTION_POOL = Object.freeze([
  "太牛了", "牛逼", "牛到飞起", "直接起飞", "起飞了", "太顶了", "顶到爆", "顶到没边", "太会了", "会到飞起",
  "太强了", "强到离谱", "强到爆炸", "直接封神", "封神", "封神了", "封神级别", "太炸了", "炸裂", "炸裂了", "炸到飞起",
  "太绝了", "绝了", "绝到不行", "绝绝子", "太6了", "666", "666了", "六到飞起", "太神了", "神了", "神到离谱",
  "太秀了", "秀到没边", "太强势了", "直接拉满", "拉满了", "太顶峰了", "顶峰相见", "太无敌了", "无敌了",
  "无敌到飞起", "太离谱了", "离谱到封神", "直接杀疯了", "杀疯了", "杀到没边", "太会玩了", "会玩到飞起",
  "太懂了", "懂到飞起", "太有东西了", "有东西到炸", "直接yyds", "yyds了", "太牛逼了", "牛逼到飞起",
  "太屌了", "屌到没边", "太猛了", "猛到爆炸", "太狠了", "狠到离谱", "太炸裂了", "炸裂到飞起",
  "太封神了", "封神到没边", "顶到天花板", "太会了吧", "会到离谱", "太强了吧", "强到没边", "太绝了吧",
  "绝到飞起", "太神了吧", "神到爆炸", "太秀了吧", "秀到飞起", "太无敌了吧", "无敌到没边", "杀疯了吧",
  "直接杀穿", "太会整了", "整到飞起", "太有料了", "有料到炸", "太顶了吧", "顶到爆表", "太牛了吧",
  "牛到没边", "太6了吧", "六到爆炸", "直接yyds了", "yyds到飞起"
]);

const REPLY_EMOTION_SKIP_PATTERN = /去世|死亡|逝者|葬|事故|受伤|灾|地震|战争|失业|诈骗|被骗|抑郁|自杀|求助|投诉|举报|道歉|悼念|医院|病危|难过|痛苦|维权|警告|风险/i;

function shouldUseReplyEmotion(text) {
  return !REPLY_EMOTION_SKIP_PATTERN.test(String(text || ""));
}

async function reserveReplyEmotion(text) {
  if (!shouldUseReplyEmotion(text)) return "";
  const state = await chrome.storage.local.get({ replyEmotionIndex: 0 });
  const index = Number.isInteger(state.replyEmotionIndex) && state.replyEmotionIndex >= 0
    ? state.replyEmotionIndex % REPLY_EMOTION_POOL.length : 0;
  await chrome.storage.local.set({ replyEmotionIndex: (index + 1) % REPLY_EMOTION_POOL.length });
  return REPLY_EMOTION_POOL[index];
}

function startsWithReplyEmotion(text) {
  const value = String(text || "").trim().toLocaleLowerCase();
  return REPLY_EMOTION_POOL.some((emotion) => value.startsWith(emotion.toLocaleLowerCase()));
}
