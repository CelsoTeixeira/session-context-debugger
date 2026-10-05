import { open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { array, identifier, object } from './json.js';
import { abortIfNeeded, DataError, Sources, within } from './source.js';
import type { Session, Sessions } from './session.js';
import type { RelationEvidence, RelationListing, RelationMatch, RelationOpen, RelationResolution, SessionRelation, SourceFile, SourceRef } from './types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const agent = /^[a-zA-Z0-9_-]{1,128}$/;
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const id = (value: unknown): string | undefined => { const valueId = identifier(value); return valueId && uuid.test(valueId) ? valueId : undefined; };

export class SessionRelationships {
  readonly links: SessionRelation[] = [];
  identity?: SourceRef;
  actorId?: string;
  rootId?: string;
  identityConflict = false;
  omitted = 0;
  private keys = new Map<string, SessionRelation>();
  constructor(readonly source: SourceFile) {}
  capture(record: Record<string, unknown>, ref: SourceRef): void {
    const payload = object(record.payload);
    const actorId = this.source.family === 'codex' && record.type === 'session_meta' ? id(payload.id)
      : this.source.family === 'claude' && ['user', 'assistant'].includes(String(record.type))
        ? identifier(record.agentId) ?? (record.isSidechain !== true ? id(record.sessionId) : undefined) : undefined;
    const rootId = this.source.family === 'codex' ? id(payload.session_id) ?? actorId : id(record.sessionId);
    if (actorId && rootId) {
      if (this.actorId && (this.actorId !== actorId || this.rootId !== rootId)) this.identityConflict = true;
      this.actorId ??= actorId; this.rootId ??= rootId;
      this.identity ??= { ...ref, pointer: this.source.family === 'codex' ? '/payload/id' : '/sessionId' };
    }
    const add = (direction: SessionRelation['direction'], key: string, label: string, pointer: string, fields: Partial<SessionRelation>) => {
      const existing = this.keys.get(direction + ':' + key);
      if (existing) {
        if (existing.agentPath && fields.agentPath && existing.agentPath !== fields.agentPath) existing.conflict = true;
        existing.agentPath ??= fields.agentPath;
        if (existing.refs.length < 8) existing.refs.push({ ...ref, pointer }); else this.omitted++;
        return;
      }
      if (this.links.length >= 256) { this.omitted++; return; }
      if (direction === 'parent' && this.links.some(link => link.direction === 'parent' && link.targetId !== fields.targetId)) {
        fields.conflict = true;
        for (const link of this.links) if (link.direction === 'parent') link.conflict = true;
      }
      const link: SessionRelation = { id: randomUUID(), direction, label, refs: [{ ...ref, pointer }], ...fields };
      this.links.push(link); this.keys.set(direction + ':' + key, link);
    };
    if (this.source.family === 'codex') {
      if (record.type === 'session_meta') {
        const spawn = object(object(object(payload.source).subagent).thread_spawn);
        const parentId = id(spawn.parent_thread_id);
        if (parentId) add('parent', parentId, 'Parent thread', '/payload/source/subagent/thread_spawn', { targetId: parentId, agentPath: identifier(spawn.agent_path) ?? identifier(payload.agent_path) });
      }
      const item = object(payload.item);
      if ((record.type === 'item_started' || record.type === 'item_completed' || record.type === 'event_msg' && ['item_started', 'item_completed'].includes(String(payload.type)))
        && item.type === 'SubAgentActivity' && id(item.agent_thread_id)) {
        add('child', String(item.agent_thread_id), identifier(item.agent_path) ?? 'Child thread', '/payload/item', { targetId: String(item.agent_thread_id), agentPath: identifier(item.agent_path) });
      }
    } else if (this.source.family === 'claude') {
      if (record.isSidechain === true && identifier(record.agentId) && id(record.sessionId) && this.identity?.id === ref.id) {
        add('parent', String(record.sessionId), 'Root recording · parent candidate', '/sessionId', { targetId: String(record.sessionId) });
      }
      if (record.type === 'assistant') array(object(record.message).content).forEach((value, i) => {
        const block = object(value), toolId = identifier(block.id);
        if (block.type === 'tool_use' && ['Agent', 'Task'].includes(String(block.name)) && toolId) {
          add('child', toolId, identifier(object(block.input).description) ?? 'Agent call', '/message/content/' + i, { toolId });
        }
      });
    }
  }
  listing(complete: boolean): RelationListing {
    return { links: this.links, complete: complete && !this.omitted, omitted: this.omitted,
      detail: 'Recorded Codex SubAgentActivity/thread-spawn and Claude Agent/Task links only. Targets are verified on request; absent links do not prove no children. At most 256 links and 8 source references per link are retained. Usage stays within the selected recording.' };
  }
}

interface Identity { ref: SourceRef; actorId: string; rootId: string; parentId?: string; agentPath?: string; agentId?: string; sidechain?: boolean }
interface Proof { path: string; ref?: SourceRef; sha256: string; bytes: number }
interface StoredResolution { sessionId: string; value: RelationResolution; proofs: Map<string, Proof>; at: number }
interface ReturnTarget { path: string; identity: SourceRef; label: string; actorId: string; rootId: string }

export class Relationships {
  private resolutions = new Map<string, StoredResolution>();
  private returns = new Map<string, ReturnTarget>();
  constructor(readonly sources: Sources) {}
  private async prefix(path: string, family: SourceFile['family'], signal?: AbortSignal): Promise<Identity | undefined> {
    const resolved = await this.sources.resolve(path);
    const handle = await open(resolved.path, 'r');
    try {
      const bytes = Buffer.alloc(512 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      abortIfNeeded(signal);
      let offset = 0;
      for (let line = 1; line <= 64; line++) {
        const end = bytes.subarray(0, bytesRead).indexOf(10, offset);
        if (end < 0) break;
        const crlf = bytes[end - 1] === 13;
        const raw = bytes.subarray(offset, end - (crlf ? 1 : 0));
        try {
          const record = object(JSON.parse(decode(raw))), payload = object(record.payload);
          const spawn = object(object(object(payload.source).subagent).thread_spawn);
          const actorId = family === 'codex' && record.type === 'session_meta' ? id(payload.id)
            : family === 'claude' && ['user', 'assistant'].includes(String(record.type))
              ? identifier(record.agentId) ?? (record.isSidechain !== true ? id(record.sessionId) : undefined) : undefined;
          const rootId = family === 'codex' ? id(payload.session_id) ?? actorId : id(record.sessionId);
          if (actorId && rootId) return { actorId, rootId, parentId: id(spawn.parent_thread_id),
            agentPath: identifier(spawn.agent_path) ?? identifier(payload.agent_path), agentId: identifier(record.agentId),
            sidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : undefined,
            ref: { id: 'r' + line, sourceId: randomUUID(), generation: randomUUID(), line, offset, byteLength: raw.length,
              delimiterLength: crlf ? 2 : 1, sha256: hash(raw), pointer: family === 'codex' ? '/payload' : '/sessionId' } };
        } catch { /* Malformed/unsupported prefixes do not prove identity. */ }
        offset = end + 1;
      }
      return undefined;
    } finally { await handle.close(); }
  }
  private async proofBytes(proof: Proof, signal?: AbortSignal): Promise<Buffer> {
    abortIfNeeded(signal);
    const path = proof.ref ? (await this.sources.resolve(proof.path)).path : await this.sources.resolveMetadata(proof.path);
    const handle = await open(path, 'r');
    try {
      if (!proof.ref && (await handle.stat()).size !== proof.bytes) throw new DataError('stale-reference', 'Relationship metadata changed; resolve the link again.', 409);
      if (proof.bytes > 512 * 1024) throw new DataError('processing-limit', 'Relationship evidence exceeds its bounded read limit.', 409);
      const bytes = Buffer.alloc(proof.bytes);
      let read = 0;
      while (read < bytes.length) {
        abortIfNeeded(signal);
        const part = await handle.read(bytes, read, bytes.length - read, (proof.ref?.offset ?? 0) + read);
        if (!part.bytesRead) break;
        read += part.bytesRead;
      }
      if (read !== bytes.length || hash(bytes) !== proof.sha256) throw new DataError('stale-reference', 'Relationship evidence changed; resolve the link again.', 409);
      return bytes;
    } finally { await handle.close(); }
  }
  private async metadata(path: string, signal?: AbortSignal): Promise<{ value: Record<string, unknown>; proof: Proof }> {
    const resolved = await this.sources.resolveMetadata(path);
    const handle = await open(resolved, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > 64 * 1024) throw new DataError('processing-limit', 'Relationship sidecar exceeds 64 KiB.', 409);
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      abortIfNeeded(signal);
      if (bytesRead !== size) throw new DataError('stale-reference', 'Relationship sidecar changed while reading.', 409);
      return { value: object(JSON.parse(decode(bytes))), proof: { path: resolved, bytes: size, sha256: hash(bytes) } };
    } finally { await handle.close(); }
  }
  async resolve(session: Session, linkId: string, signal?: AbortSignal): Promise<RelationResolution> {
    const captured = session.relationships;
    const link = captured.links.find(item => item.id === linkId);
    if (!link || session.state !== 'ready') throw new DataError('unavailable-source', 'Wait for a complete selected index and choose a recorded relationship.', 409);
    const value: RelationResolution = { id: randomUUID(), relation: link, status: 'missing', matches: [], complete: true, warnings: [] };
    const stored: StoredResolution = { sessionId: session.id, value, proofs: new Map(), at: Date.now() };
    if (!captured.identity || captured.identity.byteLength > 512 * 1024 || !captured.actorId || !captured.rootId || captured.identityConflict || link.conflict) {
      value.status = 'unavailable'; value.complete = false; value.warnings.push('Selected recording has missing or conflicting relationship identity. Inspect its source.');
    } else {
      await session.record(captured.identity.id, undefined, 0, signal);
      for (const ref of link.refs) await session.record(ref.id, undefined, 0, signal);
      const evidence = (label: string, proof: Proof): RelationEvidence => {
        const refId = randomUUID(); stored.proofs.set(refId, proof);
        return { id: refId, label, path: proof.path, ref: proof.ref, sha256: proof.sha256, bytes: proof.bytes };
      };
      const match = (path: string, identity: Identity, status: RelationMatch['status'], detail: string, extra: RelationEvidence[] = []) => {
        value.matches.push({ id: randomUUID(), path, actorId: identity.actorId, rootId: identity.rootId,
          status, detail, evidence: [...extra,
            evidence('Target identity · line ' + identity.ref.line, { path, ref: identity.ref, sha256: identity.ref.sha256, bytes: identity.ref.byteLength })] });
      };
      if (session.source.family === 'codex' && link.targetId) {
        const located = await this.sources.locate('codex', link.targetId, signal);
        value.complete = located.complete; value.warnings.push(...located.warnings);
        const visited = new Set<string>();
        for (const candidate of located.paths) {
          try {
            const path = (await this.sources.resolve(candidate)).path;
            if (visited.has(path)) continue; visited.add(path);
            const identity = await this.prefix(path, session.source.family, signal);
            if (!identity) { value.complete = false; value.warnings.push('A candidate identity was outside supported prefix coverage.'); continue; }
            const conflict = identity.actorId === captured.actorId || identity.actorId !== link.targetId || link.direction === 'child'
              && (!!identity.parentId && identity.parentId !== captured.actorId || !!link.agentPath && !!identity.agentPath && identity.agentPath !== link.agentPath);
            const missing = link.direction === 'child' && (!identity.parentId || !!link.agentPath && !identity.agentPath);
            match(path, identity, conflict ? 'conflicting' : missing ? 'unverified' : 'verified', link.direction === 'child'
              ? 'Recorded activity thread ID, child identity, parent thread ID and any recorded agent path must agree. Missing fields remain unverified.'
              : 'Recorded thread-spawn parent ID matches the target thread identity.');
          } catch { abortIfNeeded(signal); value.complete = false; value.warnings.push('A Codex candidate was unavailable or changed.'); }
        }
      } else if (session.source.family === 'claude') {
        const child = link.direction === 'parent';
        const sourcePath = session.source.resolvedPath;
        const inAgentDirectory = basename(dirname(sourcePath)) === 'subagents' && basename(dirname(dirname(sourcePath))) === captured.rootId;
        const directory = child || inAgentDirectory ? dirname(sourcePath) : join(dirname(sourcePath), captured.rootId, 'subagents');
        if (child && (basename(directory) !== 'subagents' || basename(dirname(directory)) !== captured.rootId || !agent.test(captured.actorId))) {
          value.complete = false; value.warnings.push('Child location is outside the inspected sibling-sidecar layout.');
        } else {
          try {
            const actual = await realpath(directory);
            if (!this.sources.allowedRoots().some(root => within(root, actual))) throw new DataError('unsupported-path', 'Relationship directory is outside allowed roots.', 403);
            const dir = await opendir(actual), started = Date.now();
            let inspected = 0;
            for await (const entry of dir) {
              abortIfNeeded(signal);
              if (++inspected > 256 || Date.now() - started > 4000 || value.matches.length >= 100) { value.complete = false; break; }
              if (!entry.isFile() || !/^agent-[a-zA-Z0-9_-]+\.meta\.json$/.test(entry.name)) continue;
              const actorId = entry.name.slice(6, -10);
              if (child && actorId !== captured.actorId) continue;
              try {
                const sidecar = await this.metadata(join(actual, entry.name), signal);
                const toolId = identifier(sidecar.value.toolUseId);
                if (!toolId || !child && toolId !== link.toolId) continue;
                const targetPath = child ? join(dirname(dirname(actual)), captured.rootId + '.jsonl') : join(actual, 'agent-' + actorId + '.jsonl');
                const path = (await this.sources.resolve(targetPath)).path;
                const identity = await this.prefix(path, session.source.family, signal);
                if (!identity) { value.complete = false; continue; }
                let status: RelationMatch['status'] = identity.rootId !== captured.rootId ? 'conflicting'
                  : child ? identity.actorId === captured.rootId && identity.sidechain !== true ? 'verified' : 'conflicting'
                    : !identity.agentId || identity.sidechain === undefined ? 'unverified'
                      : identity.agentId === actorId && identity.sidechain ? 'verified' : 'conflicting';
                const extra = [evidence('Agent metadata · toolUseId', sidecar.proof)];
                if (child && status === 'verified') {
                  const parent = await this.parentCall(path, captured.rootId, toolId, signal);
                  if (!parent) status = 'unverified';
                  if (parent) extra.push(evidence('Parent Agent/Task call · line ' + parent.line, { path, ref: parent, sha256: parent.sha256, bytes: parent.byteLength }));
                  else { value.complete = false; value.warnings.push('The sidecar call was not corroborated within the bounded parent scan.'); }
                }
                match(path, identity, status, 'Agent sidecar toolUseId joins the parent Agent/Task call; child agentId, root sessionId and isSidechain corroborate a separate actor. Missing evidence remains unverified.', extra);
              } catch { abortIfNeeded(signal); value.complete = false; value.warnings.push('An agent sidecar or recording was unavailable, unsupported or changed.'); }
            }
          } catch { abortIfNeeded(signal); value.complete = false; value.warnings.push('The scoped sibling-sidecar directory is unavailable.'); }
        }
        value.warnings.push('Claude discovery covers only sibling subagents metadata: at most 256 directory entries, 100 targets and 4 seconds; sidecars at most 64 KiB. Parent call scans cover at most 8 MiB / 5,000 lines. Other layouts remain unknown.');
        if (child) value.warnings.push('The root session ID supplies a parent candidate only. Reverse discovery must corroborate its Agent/Task call; parent subagent discovery remains unknown.');
      } else { value.complete = false; value.warnings.push('This provider relationship format is unsupported.'); }
      const verified = value.matches.filter(item => item.status === 'verified').length;
      value.status = verified === 1 ? 'verified' : verified > 1 ? 'ambiguous' : value.matches.length ? 'unavailable' : 'missing';
    }
    if (this.resolutions.size >= 8) this.resolutions.delete(this.resolutions.keys().next().value!);
    this.resolutions.set(value.id, stored);
    return value;
  }
  private async parentCall(path: string, actorId: string, toolId: string, signal?: AbortSignal): Promise<SourceRef | undefined> {
    const resolved = await this.sources.resolve(path), handle = await open(resolved.path, 'r');
    try {
      const bytes = Buffer.alloc(8 * 1024 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      let offset = 0;
      for (let line = 1; line <= 5000; line++) {
        abortIfNeeded(signal);
        const end = bytes.subarray(0, bytesRead).indexOf(10, offset); if (end < 0) break;
        const crlf = bytes[end - 1] === 13, raw = bytes.subarray(offset, end - (crlf ? 1 : 0));
        if (raw.length <= 512 * 1024) try {
          const value = object(JSON.parse(decode(raw)));
          const blocks = array(object(value.message).content);
          const i = value.type === 'assistant' && value.sessionId === actorId && value.isSidechain !== true
            && (!value.agentId || value.agentId === actorId) ? blocks.findIndex(item => { const block = object(item); return block.type === 'tool_use' && block.id === toolId && ['Agent', 'Task'].includes(String(block.name)); }) : -1;
          if (i >= 0) return { id: 'r' + line, sourceId: randomUUID(), generation: randomUUID(), line, offset, byteLength: raw.length, delimiterLength: crlf ? 2 : 1, sha256: hash(raw), pointer: '/message/content/' + i };
        } catch { /* Unsupported records cannot establish a parent call. */ }
        offset = end + 1;
      }
      return undefined;
    } finally { await handle.close(); }
  }
  private get(session: Session, resolutionId: string): StoredResolution {
    const stored = this.resolutions.get(resolutionId);
    if (!stored || stored.sessionId !== session.id || Date.now() - stored.at > 10 * 60_000) throw new DataError('stale-reference', 'Relationship resolution expired; resolve it again.', 409);
    return stored;
  }
  async inspect(session: Session, resolutionId: string, evidenceId: string, signal?: AbortSignal) {
    const proof = this.get(session, resolutionId).proofs.get(evidenceId);
    if (!proof) throw new DataError('unavailable-source', 'Relationship evidence is unavailable.', 404);
    const bytes = await this.proofBytes(proof, signal), text = decode(bytes);
    return { text: text.slice(0, 32000), limited: text.length > 32000, validated: true, sha256: proof.sha256, bytes: proof.bytes };
  }
  async open(session: Session, sessions: Sessions, resolutionId: string, matchId: string, signal?: AbortSignal): Promise<RelationOpen> {
    const stored = this.get(session, resolutionId), match = stored.value.matches.find(item => item.id === matchId);
    if (!match || match.status !== 'verified' || !session.relationships.identity) throw new DataError('unavailable-source', 'Choose a corroborated relationship target.', 409);
    await session.record(session.relationships.identity.id, undefined, 0, signal);
    for (const ref of stored.value.relation.refs) await session.record(ref.id, undefined, 0, signal);
    for (const evidence of match.evidence) await this.proofBytes(stored.proofs.get(evidence.id)!, signal);
    sessions.get(session.id); // A newer selection must not be replaced by a late link request.
    const targetIdentity = match.evidence.find(item => item.label.startsWith('Target identity'))!.ref!;
    const returnToken = randomUUID();
    const target = { path: session.source.originalPath, identity: session.relationships.identity, label: session.relationships.actorId!,
      actorId: session.relationships.actorId!, rootId: session.relationships.rootId! };
    const child = await sessions.open(match.path, signal, targetIdentity, { actorId: match.actorId, rootId: match.rootId });
    if (this.returns.size >= 32) this.returns.delete(this.returns.keys().next().value!);
    this.returns.set(returnToken, target);
    return { id: child.id, returnToken, returnLabel: target.label, returnRole: stored.value.relation.direction === 'child' ? 'parent' : 'child' };
  }
  async returnTo(sessions: Sessions, token: string, signal?: AbortSignal): Promise<{ id: string }> {
    const target = this.returns.get(token);
    if (!target) throw new DataError('unavailable-source', 'Navigation history was released; reopen the recording.', 404);
    await this.proofBytes({ path: target.path, ref: target.identity, sha256: target.identity.sha256, bytes: target.identity.byteLength }, signal);
    const parent = await sessions.open(target.path, signal, target.identity, { actorId: target.actorId, rootId: target.rootId });
    return { id: parent.id };
  }
}
