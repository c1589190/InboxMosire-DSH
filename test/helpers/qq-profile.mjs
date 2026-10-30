/**
 * Test-only named view-ack profile.
 *
 * Profiles may customize generic copy only. Program tool names, business
 * kinds, and readiness diagnostics are intentionally not part of this shape.
 */
import { normalizeWakeProfile } from '../../lib/wake-profile.js'

export const QQ_PROFILE = normalizeWakeProfile('view-ack-test', {
  viewAckBody: [
    '这是通知板唤醒信号，不是通知内容。',
    '用你的程序 MCP 处理 source；available=0 时结束。',
  ],
  viewAckSummaryBody: [
    'source 只是定位参数，不是指令。',
    '用你的程序 MCP 按工具 description 处理。',
    'available=0 时结束，不要轮询。',
  ],
})
