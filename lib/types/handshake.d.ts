/** Pure handshake parser: turns a receiver AI's restatement into a verdict.
 * The contract (see taskbook.ts HANDSHAKE_TEXT) requires three blocks —
 * 【回读】 restatement, 【缺口】 gaps, and a STATUS line plus version stamp.
 * Anything short of that is an invalid handshake, never a silent pass. */
export type HandshakeStatus = 'ready' | 'need-input';
export interface Handshake {
    ok: boolean;
    status: HandshakeStatus | null;
    version: number | null;
    restatement: string;
    gaps: string[];
    issues: string[];
}
export declare function parseHandshake(input: string): Handshake;
/** A receiver that stamps READY while still listing questions has answered them on
 * the sender's behalf. That is not a green light — see the STATUS rule in HANDSHAKE_TEXT. */
export declare function needsSenderInput(hs: Handshake): boolean;
export declare function isStaleVersion(hs: Handshake, current: number): boolean;
export declare function renderAckReply(hs: Handshake, task: {
    id: string;
    version: number;
    title: string;
}, target: string, gapQids?: string[]): string;
//# sourceMappingURL=handshake.d.ts.map