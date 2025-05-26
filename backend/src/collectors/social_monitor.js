// At the top of the file
const RateLimiter = require('../utils/rateLimiter');

class SocialMonitor {
    constructor(database) {
        this.db = database;
        this.rateLimiter = new RateLimiter();
        this.isMonitoring = false;
        this.monitorInterval = 90000; // Increase to 90 seconds
        // ... rest of constructor
    }

    async scanReddit(token) {
        const subreddits = ['CryptoMoonShots', 'SatoshiStreetBets', 'solana'];
        const signals = [];

        for (const subreddit of subreddits) {
            try {
                // Check rate limit before making request
                await this.rateLimiter.checkLimit('reddit');
                
                const response = await axios.get(
                    `https://www.reddit.com/r/${subreddit}/search.json?q=${token.symbol}&sort=new&limit=25&t=day`,
                    {
                        headers: { 'User-Agent': 'MemecoinBot/1.0' },
                        timeout: 5000
                    }
                );
                // ... rest of the method
            } catch (error) {
                if (error.message.includes('Rate limit')) {
                    logger.warn(`Reddit rate limit hit, skipping ${subreddit}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
        return signals;
    }
}