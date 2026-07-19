import type { AddressFamily, LookupAddress as AxiosLookupAddress } from 'axios'
import { lookup as dnsLookup } from 'dns'
import { isIP } from 'net'

/**
 * 对于 HTTP 钩子的 SSRF 防护。
 *
 * 阻止私有、链路本地和其他不可路由的地址范围，以防止项目配置的 HTTP 钩子访问云元数据端点 (169.254.169.254) 或内部基础设施。
 *
 * 回送地址 (127.0.0.0/8, ::1) 被有意允许——本地开发策略服务器是 HTTP 钩子的主要用例。
 *
 * 当使用全局代理或沙箱网络代理时，防护对于目标主机实际上被绕过，因为代理执行 DNS 解析。沙箱代理执行自己的域名白名单。
 */

/**
 * 如果地址处于 HTTP 钩子不应触及的范围，则返回 true。
 *
 * 被阻止的 IPv4：
 *   0.0.0.0/8        "本"网络
 *   10.0.0.0/8       私有
 *   100.64.0.0/10    共享地址空间 / CGNAT（某些云元数据，例如阿里云 100.100.100.200）
 *   169.254.0.0/16   链路本地（云元数据）
 *   172.16.0.0/12    私有
 *   192.0.0.0/24     IETF 协议保留
 *   192.0.2.0/24     文档地址
 *   192.168.0.0/16   私有
 *   198.18.0.0/15    网络基准测试
 *   198.51.100.0/24  文档地址
 *   203.0.113.0/24   文档地址
 *   224.0.0.0/4      组播
 *   240.0.0.0/4      保留及广播
 *
 * 被阻止的 IPv6：
 *   ::               未指定
 *   fc00::/7         唯一本地
 *   fe80::/10        链路本地
 *   fec0::/10        已弃用的站点本地
 *   ff00::/8         组播
 *   2001:db8::/32    文档地址
 *   ::ffff:<v4>      映射到被阻止范围的 IPv4
 *
 * 允许（返回 false）：
 *   127.0.0.0/8      回送（本地开发钩子）
 *   ::1              回送
 *   其他所有地址
 */
export function isBlockedAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) {
    return isBlockedV4(address)
  }
  if (v === 6) {
    return isBlockedV6(address)
  }
  // 不是有效的 IP 字面量——让真正的 DNS 路径处理它（此函数仅在 dns.lookup 返回的结果上调用，它总是返回有效的 IP）。
  return false
}

/** 判断是否满足 is Blocked V4 对应的数据或状态。 */
function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b, c] = parts
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    parts.some(n => Number.isNaN(n))
  ) {
    return false
  }

  // 回送明确允许
  if (a === 127) return false

  // 0.0.0.0/8
  if (a === 0) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 169.254.0.0/16 — 链路本地，云元数据
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 100.64.0.0/10 — 共享地址空间（RFC 6598，CGNAT）。某些云提供商使用此范围用于元数据端点（例如阿里云 100.100.100.200）。
  if (a === 100 && b >= 64 && b <= 127) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 192.0.0.0/24、192.0.2.0/24、192.88.99.0/24
  if (
    a === 192 &&
    ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))
  ) {
    return true
  }
  // 198.18.0.0/15 — 基准测试网络
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24、203.0.113.0/24 — 文档网络
  if (
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return true
  }
  // 224.0.0.0/4 组播，以及 240.0.0.0/4 保留/广播
  if (a >= 224) return true

  return false
}

/** 判断是否满足 is Blocked V6 对应的数据或状态。 */
function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase()

  // ::1 回送明确允许
  if (lower === '::1') return false

  // :: 未指定
  if (lower === '::') return true

  // IPv4 映射的 IPv6（任何表示形式中的 0:0:0:0:0:ffff:X:Y — ::ffff:a.b.c.d，::ffff:XXXX:YYYY，展开或部分展开）。提取嵌入的 IPv4 地址并委托给 v4 检查。如果没有这个，十六进制形式的映射地址（例如 ::ffff:a9fe:a9fe = 169.254.169.254）会绕过防护。
  const mappedV4 = extractMappedIPv4(lower)
  if (mappedV4 !== null) {
    return isBlockedV4(mappedV4)
  }

  const compatibleV4 = extractCompatibleIPv4(lower)
  if (compatibleV4 !== null) {
    return isBlockedV4(compatibleV4)
  }

  const nat64V4 = extractWellKnownNat64IPv4(lower)
  if (nat64V4 !== null) {
    return isBlockedV4(nat64V4)
  }

  // fc00::/7 — 唯一本地地址（fc00:: 到 fdff::）
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  }

  // fe80::/10 — 链路本地。/10 表示 fe80 到 febf，但第一个十六进制组在实践中总是 fe80（RFC 4291 要求接下来的 54 位为零）。为了安全，检查两者。
  const firstHextet = lower.split(':')[0]
  if (
    firstHextet &&
    firstHextet.length === 4 &&
    firstHextet >= 'fe80' &&
    firstHextet <= 'febf'
  ) {
    return true
  }

  const groups = expandIPv6Groups(lower)
  if (!groups) return false
  const first = groups[0]!

  // fec0::/10 — 已弃用的站点本地地址
  if ((first & 0xffc0) === 0xfec0) return true
  // ff00::/8 — 组播
  if ((first & 0xff00) === 0xff00) return true
  // 100::/64 — 丢弃前缀
  if (
    first === 0x0100 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0
  ) {
    return true
  }
  // 2001:2::/48 — 基准测试；2001:db8::/32 — 文档地址
  if (
    first === 0x2001 &&
    ((groups[1] === 0x0002 && groups[2] === 0) ||
      groups[1] === 0x0db8)
  ) {
    return true
  }
  // 2001:10::/28 — 已弃用的 ORCHID 地址
  if (
    first === 0x2001 &&
    groups[1] !== undefined &&
    groups[1] >= 0x0010 &&
    groups[1] <= 0x001f
  ) {
    return true
  }

  return false
}

/** 展开 `::` 和可选的尾部点分十进制，以便 IPv6 地址恰好表示为 8 个十六进制组。如果扩展格式不正确，则返回 null（调用者已经用 isIP 验证过，所以这是防御性的）。 */
function expandIPv6Groups(addr: string): number[] | null {
  // 处理尾部的点分十进制 IPv4（例如 ::ffff:169.254.169.254）。将其替换为两个十六进制组，以便展开的其余部分一致。
  let tailHextets: number[] = []
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    const v4 = addr.slice(lastColon + 1)
    const prefixWithSeparator = addr.slice(0, lastColon + 1)
    addr = prefixWithSeparator.endsWith('::')
      ? prefixWithSeparator
      : prefixWithSeparator.slice(0, -1)
    const octets = v4.split('.').map(Number)
    if (
      octets.length !== 4 ||
      octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null
    }
    tailHextets = [
      (octets[0]! << 8) | octets[1]!,
      (octets[2]! << 8) | octets[3]!,
    ]
  }

  // 展开 `::`（最多一个）为正确数量的零组。
  const dbl = addr.indexOf('::')
  let head: string[]
  let tail: string[]
  if (dbl === -1) {
    head = addr.split(':')
    tail = []
  } else {
    const headStr = addr.slice(0, dbl)
    const tailStr = addr.slice(dbl + 2)
    head = headStr === '' ? [] : headStr.split(':')
    tail = tailStr === '' ? [] : tailStr.split(':')
  }

  const target = 8 - tailHextets.length
  const fill = target - head.length - tail.length
  if (fill < 0) return null

  const hex = [...head, ...new Array<string>(fill).fill('0'), ...tail]
  /** 执行 nums 对应的业务处理。 */
  const nums = hex.map(h => parseInt(h, 16))
  if (nums.some(n => Number.isNaN(n) || n < 0 || n > 0xffff)) {
    return null
  }
  nums.push(...tailHextets)
  return nums.length === 8 ? nums : null
}

/**
 * 从任何有效表示形式——压缩、展开、十六进制组或尾部点分十进制——的 IPv4 映射的 IPv6 地址 (0:0:0:0:0:ffff:X:Y) 中提取嵌入的 IPv4 地址。如果地址不是 IPv4 映射的 IPv6 地址，则返回 null。
 */
function extractMappedIPv4(addr: string): string | null {
  const g = expandIPv6Groups(addr)
  if (!g) return null
  // IPv4 映射：前 80 位为零，接下来 16 位为 ffff，最后 32 位 = IPv4
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    const hi = g[6]!
    const lo = g[7]!
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return null
}

/** 从已弃用的 IPv4 兼容 IPv6 地址 `::a.b.c.d` 中提取 IPv4；排除 `::` 与 `::1`。 */
function extractCompatibleIPv4(addr: string): string | null {
  const groups = expandIPv6Groups(addr)
  if (!groups || groups.slice(0, 6).some(group => group !== 0)) return null
  const hi = groups[6]!
  const lo = groups[7]!
  if (hi === 0 && (lo === 0 || lo === 1)) return null
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** 从 RFC 6052 公共 NAT64 前缀 `64:ff9b::/96` 中提取 IPv4，以阻止私网地址绕过。 */
function extractWellKnownNat64IPv4(addr: string): string | null {
  const groups = expandIPv6Groups(addr)
  if (
    !groups ||
    groups[0] !== 0x0064 ||
    groups[1] !== 0xff9b ||
    groups.slice(2, 6).some(group => group !== 0)
  ) {
    return null
  }
  const hi = groups[6]!
  const lo = groups[7]!
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/**
 * 一个与 dns.lookup 兼容的函数，解析主机名并拒绝被阻止范围内的地址。用作 axios 请求配置中的 `lookup` 选项，以便验证后的 IP 是套接字连接到的 IP——在验证和连接之间没有重新绑定窗口。
 *
 * 主机名中的 IP 字面量直接验证，无需 DNS。
 *
 * 签名与 axios 的 `lookup` 配置选项匹配（不是 Node 的 dns.lookup）。
 */
export function ssrfGuardedLookup(
  hostname: string,
  options: object,
  callback: (
    err: Error | null,
    address: AxiosLookupAddress | AxiosLookupAddress[],
    family?: AddressFamily,
  ) => void,
): void {
  const wantsAll = 'all' in options && options.all === true

  // 如果主机名已经是 IP 字面量，直接验证它。dns.lookup 也会短路，但在此处检查会给出更清晰的错误，并避免对字面量产生任何平台特定的查找行为。
  const ipVersion = isIP(hostname)
  if (ipVersion !== 0) {
    if (isBlockedAddress(hostname)) {
      callback(ssrfError(hostname, hostname), '')
      return
    }
    const family = ipVersion === 6 ? 6 : 4
    if (wantsAll) {
      callback(null, [{ address: hostname, family }])
    } else {
      callback(null, hostname, family)
    }
    return
  }

  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, '')
      return
    }

    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        callback(ssrfError(hostname, address), '')
        return
      }
    }

    const first = addresses[0]
    if (!first) {
      callback(
        Object.assign(new Error(`ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
          hostname,
        }),
        '',
      )
      return
    }

    const family = first.family === 6 ? 6 : 4
    if (wantsAll) {
      callback(
        null,
        addresses.map(a => ({
          address: a.address,
          family: a.family === 6 ? 6 : 4,
        })),
      )
    } else {
      callback(null, first.address, family)
    }
  })
}

/** 执行 ssrf Error 对应的业务处理。 */
function ssrfError(hostname: string, address: string): NodeJS.ErrnoException {
  const err = new Error(
    `HTTP hook blocked: ${hostname} resolves to ${address} (private/link-local address). Loopback (127.0.0.1, ::1) is allowed for local dev.`,
  )
  return Object.assign(err, {
    code: 'ERR_HTTP_HOOK_BLOCKED_ADDRESS',
    hostname,
    address,
  })
}
