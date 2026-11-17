// The room-check process (server/roomCheckJob.ts runRoomJob starts it; a release runs it as dist-helper/room_check.mjs).
// stdin: one JSON job header line, then the room's bytes; stdout: one JSON line ({result} or {error, status?}).
// It runs at once when started: nothing in the server imports this file.
import { doRoomJob } from './roomCheckJob.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const answer = doRoomJob(Buffer.concat(chunks));
chunks.length = 0;
process.stdout.write(JSON.stringify(answer) + '\n');
process.exitCode = 'error' in answer ? 1 : 0;
