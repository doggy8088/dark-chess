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
]

export function cannedText(id: string): string | null {
  return CANNED_MESSAGES.find((m) => m.id === id)?.text ?? null
}
