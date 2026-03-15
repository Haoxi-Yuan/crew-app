import type { Router as RouterType } from "express";
declare const router: RouterType;
/**
 * Check for expired peaks and auto-decide them.
 * Called periodically by the peak timeout monitor.
 */
export declare function processExpiredPeaks(): {
    expired: number;
};
export default router;
