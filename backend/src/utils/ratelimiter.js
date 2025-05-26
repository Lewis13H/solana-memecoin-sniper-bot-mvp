// backend/src/utils/rateLimiter.js
class RateLimiter {
    constructor() {
        this.limits = {
            reddit: { calls: 60, window: 60000 }, // 60 per minute
            dexscreener: { calls: 300, window: 60000 }, // 300 per minute
            birdeye: { calls: 100, window: 60000 }, // 100 per minute with free tier
            jupiter: { calls: 600, window: 60000 }, // 600 per minute
            helius: { calls: 100, window: 1000 }, // 100 per second
        };
        
        this.requests = new Map();
    }

    async checkLimit(api) {
        const limit = this.limits[api];
        if (!limit) return true;
        
        const now = Date.now();
        const windowStart = now - limit.window;
        
        if (!this.requests.has(api)) {
            this.requests.set(api, []);
        }
        
        const requests = this.requests.get(api);
        const recentRequests = requests.filter(time => time > windowStart);
        
        if (recentRequests.length >= limit.calls) {
            const oldestRequest = recentRequests[0];
            const waitTime = limit.window - (now - oldestRequest) + 100;
            throw new Error(`Rate limit exceeded for ${api}. Wait ${waitTime}ms`);
        }
        
        recentRequests.push(now);
        this.requests.set(api, recentRequests);
        return true;
    }

    getRemainingCalls(api) {
        const limit = this.limits[api];
        if (!limit) return null;
        
        const now = Date.now();
        const windowStart = now - limit.window;
        const requests = this.requests.get(api) || [];
        const recentRequests = requests.filter(time => time > windowStart);
        
        return limit.calls - recentRequests.length;
    }
}

module.exports = RateLimiter;