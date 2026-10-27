import {access} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'

// Diagnose only a rejected override; never change command selection or launch it.
export async function warnInvalidAgentPath(key, value, {reason, fallback = false} = {}) {
  if (!reason && (path.isAbsolute(value) || /[\\/]/.test(value))) {
    try { await access(value, constants.R_OK) }
    catch (error) {
      reason = ['ENOENT','ENOTDIR'].includes(error.code) ? '指定文件不存在'
        : ['EACCES','EPERM'].includes(error.code) ? '没有权限读取指定文件'
        : '无法读取指定文件'
    }
  }
  reason ||= /\.(bat|ps1)$/i.test(value) ? '不支持此脚本启动格式'
    : /\.cmd$/i.test(value) ? '无法解析为可直接启动的 CLI（不支持普通批处理包装器）'
    : '未找到可启动的命令或文件'
  console.error(`[aamp-one-click] ${key} 配置无效：${reason}。请修正该变量，或清除该变量后重新扫描。${fallback ? 'AIME 将按原有流程继续检查托管适配器。' : '本次不会回退到其他安装位置。'}`)
}
