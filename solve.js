// makefun-site 1.0.0 high-speed optimized drop-in solver
import { run as fastRun } from './fast_engine.js';

export function run(input) {
  return fastRun(input);
}
