'use strict';

/**
 * Server-side request forgery (SSRF) protection for hosts that customers type in
 * (their SMTP server, bounce and replies mailboxes). MailHarbor connects to them
 * from inside the hosting network, so an internal address could be used to probe
 * services that are not meant to be reachable (the database, platform metadata).
 *
 * resolveMailHost() resolves the name once, refuses private, loopback,
 * link-local, carrier-grade NAT, unique-local and other non-public addresses,
 * and returns the IP to connect to. Connecting to that IP (with the original
 * name for TLS) means the check and the connection use the same address
 * (no DNS rebinding in between).
 */
const dns = require('node:dns').promises;
const net = require('node:net');

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4int = (ip) => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4int(ip);
    return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4int(base) / 2 ** (32 - bits)));
  }
  const a = ip.toLowerCase();
  if (a === '::' || a === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd)/.test(a) // unique local (e.g. Railway private network)
    || /^fe[89ab]/.test(a) // link local
    || /^ff/.test(a) // multicast
    || /^2001:db8:/.test(a) || /^64:ff9b:/.test(a) || /^100:/.test(a);
}

/**
 * @returns {Promise<{ address: string, servername: string }>} the IP to connect to and the name for TLS
 * @throws Error with code 'EHOSTBLOCKED' or 'EDNS'
 */
async function resolveMailHost(host, { allowPrivate = false } = {}) {
  const name = String(host || '').trim().toLowerCase();
  if (!name) throw Object.assign(new Error('No server name'), { code: 'EDNS' });
  let addresses;
  if (net.isIP(name)) addresses = [name];
  else {
    try {
      addresses = (await dns.lookup(name, { all: true, verbatim: true })).map((x) => x.address);
    } catch {
      throw Object.assign(new Error(`The server name "${name}" could not be found (DNS).`), { code: 'EDNS' });
    }
  }
  if (!allowPrivate && (name === 'localhost' || name.endsWith('.internal') || name.endsWith('.local') || addresses.some(isPrivateAddress))) {
    throw Object.assign(new Error(`"${name}" is a private or internal address. Use your mail provider's public server name.`), { code: 'EHOSTBLOCKED' });
  }
  return { address: addresses[0], servername: net.isIP(name) ? undefined : name };
}

module.exports = { resolveMailHost, isPrivateAddress };
