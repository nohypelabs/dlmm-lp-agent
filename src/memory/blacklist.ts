/**
 * Deployer / Token Blacklist
 *
 * Blocks known rug-pull and scam deployers (and their token mints) from
 * being entered by the agent.  All data is persisted to
 * data/deployer-blacklist.json — survives restarts.
 *
 * Usage:
 *   isTokenBlocked(mint)     → boolean  (call at the top of safety checks)
 *   isDeployerBlocked(addr)  → boolean
 *   blockToken(mint, reason) → void     (auto-persists)
 *   blockDeployer(addr, reason) → void
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const BLACKLIST_FILE = path.join(process.cwd(), 'data', 'deployer-blacklist.json');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BlacklistEntry {
  address: string;
  reason: string;
  addedAt: number;
  addedBy: 'auto' | 'manual';
}

export interface BlacklistStore {
  version: 1;
  updatedAt: number;
  deployers: Record<string, BlacklistEntry>; // deployer wallet → entry
  tokens: Record<string, BlacklistEntry>;    // token mint → entry
}

// ─── I/O ────────────────────────────────────────────────────────────────────

function load(): BlacklistStore {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')) as BlacklistStore;
    }
  } catch {
    logger.warn('blacklist: failed to load, starting fresh');
  }
  return { version: 1, updatedAt: 0, deployers: {}, tokens: {} };
}

function save(store: BlacklistStore): void {
  try {
    fs.mkdirSync(path.dirname(BLACKLIST_FILE), { recursive: true });
    store.updatedAt = Date.now();
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error(`blacklist: save failed: ${err}`);
  }
}

// ─── Deployer API ────────────────────────────────────────────────────────────

/**
 * Add a deployer wallet to the blacklist.
 * @param address  Solana wallet public key (base58).
 * @param reason   Human-readable reason (e.g. "rug-pulled TOKEN_XYZ").
 * @param source   'auto' (agent-triggered) or 'manual' (operator). Defaults to 'manual'.
 */
export function blockDeployer(
  address: string,
  reason: string,
  source: 'auto' | 'manual' = 'manual',
): void {
  const store = load();
  if (store.deployers[address]) {
    logger.debug(`blacklist: deployer ${address} already blocked`);
    return;
  }
  store.deployers[address] = {
    address,
    reason,
    addedAt: Date.now(),
    addedBy: source,
  };
  save(store);
  logger.info(`blacklist: blocked deployer ${address} (${source}) — ${reason}`);
}

/** Remove a deployer wallet from the blacklist. */
export function unblockDeployer(address: string): void {
  const store = load();
  if (!store.deployers[address]) {
    logger.debug(`blacklist: deployer ${address} not in blacklist`);
    return;
  }
  delete store.deployers[address];
  save(store);
  logger.info(`blacklist: unblocked deployer ${address}`);
}

/** Returns true if the deployer wallet is blacklisted. */
export function isDeployerBlocked(address: string): boolean {
  const store = load();
  return address in store.deployers;
}

/** Get all blocked deployer entries. */
export function getBlockedDeployers(): BlacklistEntry[] {
  const store = load();
  return Object.values(store.deployers);
}

// ─── Token API ───────────────────────────────────────────────────────────────

/**
 * Add a token mint address to the blacklist.
 * @param address  SPL token mint (base58).
 * @param reason   Human-readable reason.
 * @param source   'auto' or 'manual'. Defaults to 'manual'.
 */
export function blockToken(
  address: string,
  reason: string,
  source: 'auto' | 'manual' = 'manual',
): void {
  const store = load();
  if (store.tokens[address]) {
    logger.debug(`blacklist: token ${address} already blocked`);
    return;
  }
  store.tokens[address] = {
    address,
    reason,
    addedAt: Date.now(),
    addedBy: source,
  };
  save(store);
  logger.info(`blacklist: blocked token ${address} (${source}) — ${reason}`);
}

/** Remove a token mint from the blacklist. */
export function unblockToken(address: string): void {
  const store = load();
  if (!store.tokens[address]) {
    logger.debug(`blacklist: token ${address} not in blacklist`);
    return;
  }
  delete store.tokens[address];
  save(store);
  logger.info(`blacklist: unblocked token ${address}`);
}

/** Returns true if the token mint is blacklisted. */
export function isTokenBlocked(address: string): boolean {
  const store = load();
  return address in store.tokens;
}

/** Get all blocked token entries. */
export function getBlockedTokens(): BlacklistEntry[] {
  const store = load();
  return Object.values(store.tokens);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

/** Returns counts for both blacklist categories. */
export function getStats(): { deployers: number; tokens: number } {
  const store = load();
  return {
    deployers: Object.keys(store.deployers).length,
    tokens: Object.keys(store.tokens).length,
  };
}
