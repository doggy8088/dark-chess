/** Quick-chat canned messages. The server accepts only ids on this list. */

export interface CannedMessage {
  id: string
  text: string
}

export const CANNED_MESSAGES: readonly CannedMessage[] = [
  { id: 'hello', text: '哈囉，請多指教！' },
  { id: 'hurry', text: '快下啦～' },
  { id: 'thinking-long', text: '想這麼久喔？' },
  { id: 'nice-move', text: '好棋！' },
  { id: 'oops', text: '哎呀，失誤了…' },
  { id: 'doomed', text: '你完蛋了 😏' },
  { id: 'wait', text: '等等，讓我想一下' },
  { id: 'thanks', text: '承讓承讓～' },
  { id: 'trap', text: '這步是陷阱吧？' },
  { id: 'lucky-flip', text: '翻到好棋，羨慕！' },
  { id: 'lag', text: '網路卡了嗎？' },
  { id: 'rematch', text: '再來一局啦！' },
  { id: 'gg', text: 'GG，打得不錯 🫡' },
  { id: 'laugh', text: '哈哈哈哈笑死 😂' },
  { id: 'sweat', text: '冷汗直流 💦' },
  { id: 'confident', text: '穩了穩了，這把穩了 😎' },
  { id: 'panic', text: '慘了慘了 😱' },
  { id: 'come-on', text: '來啊，誰怕誰 🔥' },
  { id: 'no-way', text: '不會吧，這樣也行？🙄' },
  { id: 'turtle', text: '你是慢動作重播嗎 🐢' },
  { id: 'hand-slip', text: '剛剛是手滑，不算！' },
  { id: 'next-time', text: '下次我一定贏回來 💪' },
  { id: 'kneel', text: '太強了，膝蓋給你 🙇' },
  { id: 'pure-luck', text: '純粹運氣好而已 🎲' },
  { id: 'scared', text: '你在怕什麼 😏' },
  { id: 'sleepy', text: '想那麼久，睡著了嗎 😴' },
  { id: 'trump-card', text: '看我的大招 ✨' },
  { id: 'sorry', text: '抱歉抱歉，手誤手誤 🙏' },
  { id: 'well-played', text: '打得漂亮 👏' },
  { id: 'crying', text: '我要哭了啦 😭' },
  { id: 'messy', text: '你這棋下得跟我房間一樣亂 🫠' },
  { id: 'brain-melt', text: '好燒腦，CPU 要燒了 🤯' },
  { id: 'mercy', text: '饒了我吧 🥺' },
  { id: 'popcorn', text: '好戲在後頭，先吃爆米花 🍿' },
  { id: 'flip-god', text: '又是你翻？你是牌神喔 🃏' },
  { id: 'all-in', text: '一步定生死，衝了 ⚔️' },
]

export function cannedText(id: string): string | null {
  return CANNED_MESSAGES.find((m) => m.id === id)?.text ?? null
}
