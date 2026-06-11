import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  BotIdentity,
  CardActionEvent,
  LarkChannel,
  NormalizedMessage,
  SendInput,
  SendOptions,
  SendResult,
} from '@larksuiteoapi/node-sdk'

interface LarkCliChannelOptions {
  cliBin: string
  profile: string
  logger?: Pick<Console, 'log' | 'error'>
}

interface LarkCliMessageEvent {
  chat_id?: string
  chat_type?: 'p2p' | 'group'
  content?: string
  create_time?: string
  event_id?: string
  message_id?: string
  message_type?: string
  sender_id?: string
  timestamp?: string
  type?: string
}

export class LarkCliChannel {
  readonly rawClient: LarkChannel['rawClient']
  botIdentity?: BotIdentity

  private readonly cliBin: string
  private readonly profile: string
  private readonly logger: Pick<Console, 'log' | 'error'>
  private readonly emitter = new EventEmitter()
  private readonly consumers: ChildProcessWithoutNullStreams[] = []
  private connected = false

  constructor(options: LarkCliChannelOptions) {
    this.cliBin = options.cliBin
    this.profile = options.profile
    this.logger = options.logger ?? console
    this.rawClient = this.createRawClient()
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.botIdentity = await this.fetchBotIdentity()
    await this.startConsumer('im.message.receive_v1')
    await this.startOptionalConsumer('card.action.trigger')
    this.connected = true
  }

  async disconnect(): Promise<void> {
    for (const consumer of this.consumers.splice(0)) {
      consumer.kill('SIGTERM')
    }
    this.connected = false
  }

  on(nameOrHandlers: string | Record<string, (...args: unknown[]) => void>, handler?: (...args: unknown[]) => void): () => void {
    if (typeof nameOrHandlers === 'object') {
      const unsubscribers = Object.entries(nameOrHandlers).map(([name, value]) => this.on(name, value))
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
    if (!handler) return () => {}
    this.emitter.on(nameOrHandlers, handler)
    return () => this.emitter.off(nameOrHandlers, handler)
  }

  async send(to: string, input: SendInput, options: SendOptions = {}): Promise<SendResult> {
    if ('card' in input) {
      return this.sendRawMessage(to, 'interactive', JSON.stringify(input.card), options)
    }
    if ('markdown' in input) {
      return this.runMessageShortcut(options.replyTo ? '+messages-reply' : '+messages-send', {
        target: to,
        textFlag: '--markdown',
        text: input.markdown,
        options,
      })
    }
    if ('text' in input) {
      return this.runMessageShortcut(options.replyTo ? '+messages-reply' : '+messages-send', {
        target: to,
        textFlag: '--text',
        text: input.text,
        options,
      })
    }
    if ('file' in input) {
      const source = await this.materializeMediaSource(input.file.source, input.file.fileName)
      return this.runMessageShortcut(options.replyTo ? '+messages-reply' : '+messages-send', {
        target: to,
        mediaFlag: '--file',
        mediaPath: source,
        options,
      })
    }
    if ('image' in input) {
      const source = await this.materializeMediaSource(input.image.source, 'image.png')
      return this.runMessageShortcut(options.replyTo ? '+messages-reply' : '+messages-send', {
        target: to,
        mediaFlag: '--image',
        mediaPath: source,
        options,
      })
    }
    throw new Error('lark-cli channel does not support this send input yet.')
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.api('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const response = await this.api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      data: {
        reaction_type: { emoji_type: emojiType },
      },
    })
    return this.pickString(response, ['reaction_id']) ?? ''
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.api('DELETE', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`)
  }

  async downloadResource(fileKey: string, type: 'image' | 'file'): Promise<Buffer> {
    const output = path.join(await mkdtemp(path.join(os.tmpdir(), 'aamp-lark-cli-resource-')), fileKey)
    const pathSuffix = type === 'image'
      ? `/open-apis/im/v1/images/${encodeURIComponent(fileKey)}`
      : `/open-apis/im/v1/files/${encodeURIComponent(fileKey)}`
    await this.runCli(['api', 'GET', pathSuffix, '--as', 'bot', '--profile', this.profile, '--output', output])
    const { readFile } = await import('node:fs/promises')
    return readFile(output)
  }

  private createRawClient(): LarkChannel['rawClient'] {
    return {
      cardkit: {
        v1: {
          card: {
            create: (request: { data?: unknown }) => this.api('POST', '/open-apis/cardkit/v1/cards', { data: request.data }),
            update: (request: { path: { card_id: string }, data?: unknown }) =>
              this.api('PUT', `/open-apis/cardkit/v1/cards/${encodeURIComponent(request.path.card_id)}`, { data: request.data }),
            settings: (request: { path: { card_id: string }, data?: unknown }) =>
              this.api('PATCH', `/open-apis/cardkit/v1/cards/${encodeURIComponent(request.path.card_id)}/settings`, { data: request.data }),
          },
          cardElement: {
            content: (request: { path: { card_id: string, element_id: string }, data?: unknown }) =>
              this.api(
                'PATCH',
                `/open-apis/cardkit/v1/cards/${encodeURIComponent(request.path.card_id)}/elements/${encodeURIComponent(request.path.element_id)}/content`,
                { data: request.data },
              ),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: (request: { params?: unknown, data?: { receive_id?: string, msg_type?: string, content?: string } }) =>
              this.api('POST', '/open-apis/im/v1/messages', { params: request.params, data: request.data }),
            reply: (request: { path: { message_id: string }, data?: { msg_type?: string, content?: string, reply_in_thread?: boolean } }) =>
              this.api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(request.path.message_id)}/reply`, { data: request.data }),
            get: (request: { path: { message_id: string }, params?: unknown }) =>
              this.api('GET', `/open-apis/im/v1/messages/${encodeURIComponent(request.path.message_id)}`, { params: request.params }),
          },
          messageResource: {
            get: (request: { path: { message_id: string, file_key: string }, params?: unknown }) =>
              this.api('GET', `/open-apis/im/v1/messages/${encodeURIComponent(request.path.message_id)}/resources/${encodeURIComponent(request.path.file_key)}`, { params: request.params }),
          },
        },
      },
    } as LarkChannel['rawClient']
  }

  private async startOptionalConsumer(eventKey: string): Promise<void> {
    const schema = await this.runCli(['event', 'schema', eventKey, '--json', '--profile', this.profile], { rejectOnFailure: false })
    if (schema.status !== 0) {
      this.logger.log(`[lark-cli] event key unavailable: ${eventKey}`)
      return
    }
    await this.startConsumer(eventKey)
  }

  private async startConsumer(eventKey: string): Promise<void> {
    const child = spawn(this.cliBin, ['event', 'consume', eventKey, '--as', 'bot', '--profile', this.profile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.consumers.push(child)
    let stdoutBuffer = ''
    let stderrBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) this.handleEventLine(eventKey, line)
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      let newlineIndex = stderrBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stderrBuffer.slice(0, newlineIndex).trim()
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1)
        if (line) this.logger.log(`[lark-cli event ${eventKey}] ${line}`)
        newlineIndex = stderrBuffer.indexOf('\n')
      }
    })
    child.on('error', (error) => this.emitter.emit('error', error))
    child.on('exit', (code) => {
      if (this.connected && code !== 0) {
        this.emitter.emit('error', new Error(`lark-cli event ${eventKey} exited with ${code ?? 'unknown status'}`))
      }
    })
  }

  private handleEventLine(eventKey: string, line: string): void {
    try {
      const event = JSON.parse(line) as unknown
      if (eventKey === 'im.message.receive_v1') {
        const message = this.normalizeMessageEvent(event)
        if (message) this.emitter.emit('message', message)
        return
      }
      if (eventKey === 'card.action.trigger') {
        const action = this.normalizeCardActionEvent(event)
        if (action) this.emitter.emit('cardAction', action)
      }
    } catch (error) {
      this.emitter.emit('error', error)
    }
  }

  private normalizeMessageEvent(value: unknown): NormalizedMessage | null {
    const event = value && typeof value === 'object' ? value as LarkCliMessageEvent : {}
    if (!event.message_id || !event.chat_id || !event.sender_id) return null
    return {
      messageId: event.message_id,
      chatId: event.chat_id,
      chatType: event.chat_type ?? 'p2p',
      senderId: event.sender_id,
      content: event.content ?? '',
      rawContentType: event.message_type ?? '',
      resources: [],
      mentions: this.botIdentity && event.content?.includes(this.botIdentity.name)
        ? [{ key: this.botIdentity.name, openId: this.botIdentity.openId, name: this.botIdentity.name, isBot: true }]
        : [],
      mentionAll: event.content?.includes('@all') ?? false,
      mentionedBot: this.botIdentity ? (event.content?.includes(this.botIdentity.name) ?? false) : false,
      createTime: Number(event.create_time ?? event.timestamp ?? Date.now()),
      raw: value,
    }
  }

  private normalizeCardActionEvent(value: unknown): CardActionEvent | null {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const event = (record.event && typeof record.event === 'object' ? record.event : record) as Record<string, unknown>
    const context = event.context && typeof event.context === 'object' ? event.context as Record<string, unknown> : {}
    const operator = event.operator && typeof event.operator === 'object' ? event.operator as Record<string, unknown> : {}
    const action = event.action && typeof event.action === 'object' ? event.action as Record<string, unknown> : {}
    const messageId = this.asString(context.open_message_id) ?? this.asString(event.open_message_id)
    const chatId = this.asString(context.open_chat_id) ?? this.asString(event.open_chat_id)
    const openId = this.asString(operator.open_id)
    if (!messageId || !chatId || !openId) return null
    return {
      messageId,
      chatId,
      operator: {
        openId,
        userId: this.asString(operator.user_id),
        name: this.asString(operator.name),
      },
      action: {
        value: action.value,
        tag: this.asString(action.tag) ?? '',
        name: this.asString(action.name),
        option: this.asString(action.option),
      },
      raw: value,
    }
  }

  private async fetchBotIdentity(): Promise<BotIdentity> {
    const response = await this.api('GET', '/open-apis/bot/v3/info')
    const bot = response.bot && typeof response.bot === 'object' ? response.bot as Record<string, unknown> : {}
    return {
      openId: this.asString(bot.open_id) ?? '',
      name: this.asString(bot.app_name) ?? this.profile,
    }
  }

  private async sendRawMessage(to: string, msgType: string, content: string, options: SendOptions = {}): Promise<SendResult> {
    const response = options.replyTo
      ? await this.rawClient.im.v1.message.reply({
          path: { message_id: options.replyTo },
          data: {
            msg_type: msgType,
            content,
            reply_in_thread: options.replyInThread === true,
          },
        } as never)
      : await this.rawClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: to,
            msg_type: msgType,
            content,
          },
        } as never)
    const messageId = this.pickString(response, ['message_id', 'messageId'])
    if (!messageId) throw new Error('lark-cli message send returned no message_id')
    return { messageId }
  }

  private async runMessageShortcut(command: '+messages-send' | '+messages-reply', options: {
    target: string
    textFlag?: '--text' | '--markdown'
    text?: string
    mediaFlag?: '--file' | '--image'
    mediaPath?: string
    options: SendOptions
  }): Promise<SendResult> {
    const args = ['im', command, '--as', 'bot', '--profile', this.profile]
    if (command === '+messages-send') {
      args.push('--chat-id', options.target)
    } else if (options.options.replyTo) {
      args.push('--message-id', options.options.replyTo)
      if (options.options.replyInThread) args.push('--reply-in-thread')
    }
    if (options.textFlag && options.text != null) args.push(options.textFlag, options.text)
    if (options.mediaFlag && options.mediaPath) args.push(options.mediaFlag, options.mediaPath)
    const result = await this.runCli(args)
    const parsed = this.parseJsonObject(result.stdout)
    const messageId = this.pickString(parsed, ['message_id', 'messageId'])
    if (!messageId) throw new Error('lark-cli message shortcut returned no message_id')
    return { messageId }
  }

  private async api(method: string, apiPath: string, options: { params?: unknown, data?: unknown } = {}): Promise<Record<string, unknown>> {
    const args = ['api', method, apiPath, '--as', 'bot', '--profile', this.profile, '--format', 'json']
    if (options.params) args.push('--params', JSON.stringify(options.params))
    if (options.data) args.push('--data', JSON.stringify(options.data))
    const result = await this.runCli(args)
    return this.parseJsonObject(result.stdout)
  }

  private async runCli(args: string[], options: { rejectOnFailure?: boolean } = {}): Promise<{ stdout: string, stderr: string, status: number }> {
    const rejectOnFailure = options.rejectOnFailure ?? true
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        const status = code ?? 0
        if (rejectOnFailure && status !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `${this.cliBin} ${args.join(' ')} exited with ${status}`))
          return
        }
        resolve({ stdout, stderr, status })
      })
    })
  }

  private parseJsonObject(value: string): Record<string, unknown> {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  }

  private pickString(value: unknown, keys: string[]): string | undefined {
    const visit = (item: unknown): string | undefined => {
      if (!item || typeof item !== 'object') return undefined
      if (Array.isArray(item)) {
        for (const child of item) {
          const found = visit(child)
          if (found) return found
        }
        return undefined
      }
      const record = item as Record<string, unknown>
      for (const key of keys) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      }
      for (const child of Object.values(record)) {
        const found = visit(child)
        if (found) return found
      }
      return undefined
    }
    return visit(value)
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  private async materializeMediaSource(source: string | Buffer, filename: string): Promise<string> {
    if (typeof source === 'string') return source
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aamp-lark-cli-media-'))
    const filePath = path.join(dir, filename)
    await writeFile(filePath, source)
    return filePath
  }
}
