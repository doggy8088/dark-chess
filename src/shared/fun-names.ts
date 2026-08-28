import { secureRandomInt } from '../game/shuffle'

/**
 * Playful default nicknames for online seats and spectators, so the chat
 * reads like a night-market crowd instead of 玩家一 vs 玩家二.
 * Keep every name ≤ 12 chars — the server truncates nicknames at 12.
 */
export const FUN_NAMES: readonly string[] = [
  '板橋彭魚晏',
  '台中金城武',
  '無法自拔的帥',
  '淡水小籠包',
  '羅東夜市之狼',
  '墾丁曬傷哥',
  '九份階梯之王',
  '士林大力士',
  '深坑豆腐達人',
  '宜蘭蔥油餅俠',
  '台南虱目魚王',
  '彰化肉圓俠',
  '基隆雨神',
  '新竹風之子',
  '花蓮浪人',
  '澎湖灣海豚',
  '永和豆漿伯',
  '三重地下王',
  '桃園散步哥',
  '烏來溫泉蛋',
  '一隻帥氣的蝸牛',
  '蓋牌小天才',
  '暗棋界的一股清流',
  '翻牌小學徒',
  '棋盤上的幽靈',
  '專業陪笑觀眾',
  '今晚想吃滷肉飯',
  '減肥從明天開始',
  '阿嬤養大的孩子',
  '週一症候群患者',
  '零用錢保管員',
  '遲到大王本人',
  '全聯打折之神',
  '手搖飲品鑑師',
  '養樂多戰士',
  '假日補眠專家',
]

/** Placeholders that mean "the user never picked a name". */
const PLACEHOLDER_NAMES = new Set(['玩家一', '玩家二', '觀眾'])

/** Crypto-random fun nickname; avoids the given name when possible. */
export function randomFunName(avoid?: string): string {
  for (let i = 0; i < 10; i++) {
    const name = FUN_NAMES[secureRandomInt(FUN_NAMES.length)]!
    if (name !== avoid) return name
  }
  return FUN_NAMES[secureRandomInt(FUN_NAMES.length)]!
}

/** A usable nickname: the saved one when customized, otherwise a random fun name. */
export function resolveNickname(saved?: string | null): string {
  const trimmed = (saved ?? '').trim()
  if (trimmed && !PLACEHOLDER_NAMES.has(trimmed)) return trimmed
  return randomFunName(trimmed || undefined)
}