// backend/src/collectors/influencer_tracker.js
const axios = require('axios');
const logger = require('../utils/logger');

class InfluencerTracker {
    constructor(database, tradingEngine) {
        this.db = database;
        this.tradingEngine = tradingEngine;
        this.isTracking = false;
        this.checkInterval = 30000; // 30 seconds
        
        // Known high-value influencers (you can expand this list)
        this.influencers = new Map([
            // Tier S - Elite influencers
            ['blknoiz06', { platform: 'twitter', tier: 'S', weight: 10, minFollowers: 100000 }],
            ['inversebrah', { platform: 'twitter', tier: 'S', weight: 10, minFollowers: 50000 }],
            ['CryptoGodJohn', { platform: 'twitter', tier: 'S', weight: 10, minFollowers: 200000 }],
            
            // Tier A - Proven track record
            ['cryptodog', { platform: 'twitter', tier: 'A', weight: 7, minFollowers: 30000 }],
            ['trader_XO', { platform: 'twitter', tier: 'A', weight: 7, minFollowers: 25000 }],
            ['Moonshot_Calls', { platform: 'twitter', tier: 'A', weight: 7, minFollowers: 40000 }],
            
            // Tier B - Rising stars
            ['gem_hunter_sol', { platform: 'twitter', tier: 'B', weight: 5, minFollowers: 10000 }],
            ['solana_alpha', { platform: 'twitter', tier: 'B', weight: 5, minFollowers: 15000 }],
            
            // Reddit influencers
            ['SolanaTrader', { platform: 'reddit', tier: 'A', weight: 7, minFollowers: 0 }],
            ['CryptoMoonShots', { platform: 'reddit', tier: 'B', weight: 5, minFollowers: 0 }]
        ]);
        
        // Track performance
        this.performanceHistory = new Map();
        this.recentCalls = new Map();
        
        // Keywords that indicate strong conviction
        this.bullishKeywords = [
            'buying', 'bought', 'aped', 'aping', 'bullish', 'moon', 'gem', 
            'accumulating', '100x', '1000x', 'sending', 'early', 'alpha',
            'loaded', 'filling bags', 'don\'t fade', 'lfg', 'wagmi'
        ];
        
        this.bearishKeywords = [
            'selling', 'sold', 'dump', 'rug', 'scam', 'avoid', 'stay away',
            'bearish', 'short', 'fade', 'trash', 'garbage'
        ];
    }

    async startTracking() {
        if (this.isTracking) return;
        
        this.isTracking = true;
        logger.info('🎯 Influencer tracking system started');
        
        // Initial check
        await this.checkInfluencerActivity();
        
        // Continuous monitoring
        this.trackingTimer = setInterval(async () => {
            try {
                await this.checkInfluencerActivity();
            } catch (error) {
                logger.error('Influencer tracking error:', error);
            }
        }, this.checkInterval);
        
        // Load historical performance
        await this.loadHistoricalPerformance();
    }

    async checkInfluencerActivity() {
        const activities = [];
        
        // Check Twitter if API available
        if (process.env.TWITTER_BEARER_TOKEN) {
            const twitterActivity = await this.checkTwitterInfluencers();
            activities.push(...twitterActivity);
        }
        
        // Always check Reddit (free)
        const redditActivity = await this.checkRedditInfluencers();
        activities.push(...redditActivity);
        
        // Process high-value signals
        for (const activity of activities) {
            await this.processInfluencerSignal(activity);
        }
    }

    async checkTwitterInfluencers() {
        const activities = [];
        
        try {
            // Using Twitter API v2 search
            const twitterInfluencers = Array.from(this.influencers.entries())
                .filter(([_, info]) => info.platform === 'twitter')
                .map(([handle, _]) => handle);
            
            const query = twitterInfluencers.map(h => `from:${h}`).join(' OR ');
            
            const response = await axios.get(
                'https://api.twitter.com/2/tweets/search/recent',
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
                    },
                    params: {
                        query: query + ' (SOL OR $)',
                        'tweet.fields': 'created_at,public_metrics,author_id',
                        'max_results': 100
                    },
                    timeout: 10000
                }
            );
            
            if (response.data && response.data.data) {
                for (const tweet of response.data.data) {
                    const activity = await this.parseTweetForSignals(tweet);
                    if (activity) {
                        activities.push(activity);
                    }
                }
            }
        } catch (error) {
            logger.warn('Twitter API error:', error.message);
        }
        
        return activities;
    }

    async checkRedditInfluencers() {
        const activities = [];
        const subreddits = ['CryptoMoonShots', 'SatoshiStreetBets', 'solana'];
        
        for (const subreddit of subreddits) {
            try {
                const response = await axios.get(
                    `https://www.reddit.com/r/${subreddit}/new.json?limit=25`,
                    {
                        headers: { 'User-Agent': 'MemecoinBot/1.0' },
                        timeout: 5000
                    }
                );
                
                const posts = response.data?.data?.children || [];
                
                for (const post of posts) {
                    const postData = post.data;
                    const authorInfo = this.influencers.get(postData.author);
                    
                    // Check if it's from a tracked influencer or has high engagement
                    if (authorInfo || this.isHighEngagementPost(postData)) {
                        const activity = this.parseRedditPostForSignals(postData, authorInfo);
                        if (activity) {
                            activities.push(activity);
                        }
                    }
                }
            } catch (error) {
                logger.warn(`Reddit scan failed for ${subreddit}:`, error.message);
            }
        }
        
        return activities;
    }

    async parseTweetForSignals(tweet) {
        const text = tweet.text.toLowerCase();
        const tokens = this.extractTokenMentions(text);
        
        if (tokens.length === 0) return null;
        
        const sentiment = this.analyzeSentiment(text);
        const urgency = this.calculateUrgency(tweet);
        
        return {
            platform: 'twitter',
            influencer: tweet.author_id, // Would need to map to handle
            content: tweet.text,
            tokens: tokens,
            sentiment: sentiment,
            urgency: urgency,
            engagement: tweet.public_metrics,
            timestamp: new Date(tweet.created_at)
        };
    }

    parseRedditPostForSignals(postData, influencerInfo) {
        const text = (postData.title + ' ' + (postData.selftext || '')).toLowerCase();
        const tokens = this.extractTokenMentions(text);
        
        if (tokens.length === 0) return null;
        
        const sentiment = this.analyzeSentiment(text);
        const urgency = this.calculateRedditUrgency(postData, influencerInfo);
        
        return {
            platform: 'reddit',
            influencer: postData.author,
            content: postData.title,
            tokens: tokens,
            sentiment: sentiment,
            urgency: urgency,
            engagement: {
                score: postData.score,
                comments: postData.num_comments,
                upvote_ratio: postData.upvote_ratio
            },
            timestamp: new Date(postData.created_utc * 1000),
            url: `https://reddit.com${postData.permalink}`
        };
    }

    extractTokenMentions(text) {
        const tokens = [];
        
        // Match $SYMBOL pattern
        const dollarMatches = text.match(/\$[A-Z]{2,10}/g) || [];
        tokens.push(...dollarMatches.map(m => m.substring(1)));
        
        // Match "buy SYMBOL" or "buying SYMBOL" patterns
        const buyMatches = text.match(/(?:buy|buying|bought|aped)\s+([A-Z]{2,10})/gi) || [];
        tokens.push(...buyMatches.map(m => m.split(' ')[1].toUpperCase()));
        
        // Match contract addresses (Solana addresses are 32-44 chars)
        const addressMatches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
        tokens.push(...addressMatches);
        
        // Remove duplicates and common false positives
        const filtered = [...new Set(tokens)].filter(token => 
            !['THE', 'AND', 'FOR', 'USD', 'USDT', 'USDC', 'BTC', 'ETH'].includes(token)
        );
        
        return filtered;
    }

    analyzeSentiment(text) {
        let score = 0;
        
        // Check bullish keywords
        for (const keyword of this.bullishKeywords) {
            if (text.includes(keyword)) score += 1;
        }
        
        // Check bearish keywords
        for (const keyword of this.bearishKeywords) {
            if (text.includes(keyword)) score -= 2; // Bearish signals weighted more
        }
        
        // Check for excitement indicators
        const exclamationCount = (text.match(/!/g) || []).length;
        const rocketCount = (text.match(/🚀/g) || []).length;
        const moonCount = (text.match(/🌙|🌕/g) || []).length;
        const fireCount = (text.match(/🔥/g) || []).length;
        
        score += Math.min(exclamationCount * 0.5, 2);
        score += rocketCount * 2;
        score += moonCount * 1.5;
        score += fireCount * 1;
        
        // Normalize to -1 to 1 range
        return Math.max(-1, Math.min(1, score / 10));
    }

    calculateUrgency(tweet) {
        let urgency = 50; // Base urgency
        
        // Time factor - newer is more urgent
        const ageMinutes = (Date.now() - new Date(tweet.created_at)) / (1000 * 60);
        if (ageMinutes < 5) urgency += 30;
        else if (ageMinutes < 15) urgency += 20;
        else if (ageMinutes < 30) urgency += 10;
        
        // Engagement velocity
        const engagementRate = (tweet.public_metrics.like_count + 
                               tweet.public_metrics.retweet_count * 2) / 
                               Math.max(ageMinutes, 1);
        urgency += Math.min(engagementRate * 2, 20);
        
        return Math.min(100, urgency);
    }

    calculateRedditUrgency(postData, influencerInfo) {
        let urgency = 40; // Base urgency for Reddit
        
        // Influencer tier bonus
        if (influencerInfo) {
            const tierBonus = { 'S': 30, 'A': 20, 'B': 10 };
            urgency += tierBonus[influencerInfo.tier] || 0;
        }
        
        // Time factor
        const ageMinutes = (Date.now() - (postData.created_utc * 1000)) / (1000 * 60);
        if (ageMinutes < 15) urgency += 20;
        else if (ageMinutes < 30) urgency += 10;
        
        // Engagement factor
        const engagementScore = postData.score + (postData.num_comments * 2);
        if (engagementScore > 100) urgency += 20;
        else if (engagementScore > 50) urgency += 10;
        
        return Math.min(100, urgency);
    }

    isHighEngagementPost(postData) {
        const ageHours = (Date.now() - (postData.created_utc * 1000)) / (1000 * 60 * 60);
        const scorePerHour = postData.score / Math.max(ageHours, 0.1);
        
        return scorePerHour > 20 || // 20+ upvotes per hour
               postData.num_comments > 20 || // High discussion
               postData.upvote_ratio > 0.9; // Very positive reception
    }

    async processInfluencerSignal(activity) {
        // Check if we've seen this recently
        const signalKey = `${activity.influencer}-${activity.tokens.join('-')}`;
        const lastSeen = this.recentCalls.get(signalKey);
        
        if (lastSeen && (Date.now() - lastSeen) < 3600000) { // 1 hour cooldown
            return;
        }
        
        this.recentCalls.set(signalKey, Date.now());
        
        // Get influencer info
        const influencerInfo = this.influencers.get(activity.influencer) || {
            tier: 'C',
            weight: 3
        };
        
        // Calculate signal strength
        const signalStrength = this.calculateSignalStrength(activity, influencerInfo);
        
        logger.info(`🎯 Influencer signal detected:`, {
            influencer: activity.influencer,
            platform: activity.platform,
            tokens: activity.tokens,
            sentiment: activity.sentiment.toFixed(2),
            urgency: activity.urgency,
            strength: signalStrength
        });
        
        // Execute trade if signal is strong enough
        if (signalStrength > 70 && activity.sentiment > 0.3) {
            for (const token of activity.tokens) {
                await this.executeInfluencerTrade(token, activity, signalStrength);
            }
        }
        
        // Store for performance tracking
        await this.storeInfluencerCall(activity, signalStrength);
    }

    calculateSignalStrength(activity, influencerInfo) {
        let strength = 0;
        
        // Base strength from influencer tier
        strength += influencerInfo.weight * 5;
        
        // Sentiment factor (max 30 points)
        strength += activity.sentiment * 30;
        
        // Urgency factor (max 20 points)
        strength += activity.urgency * 0.2;
        
        // Platform factor
        if (activity.platform === 'twitter') strength += 10;
        
        // Engagement factor
        if (activity.platform === 'twitter') {
            const totalEngagement = activity.engagement.like_count + 
                                  activity.engagement.retweet_count * 2;
            strength += Math.min(totalEngagement / 10, 10);
        } else if (activity.platform === 'reddit') {
            strength += Math.min(activity.engagement.score / 10, 10);
        }
        
        return Math.min(100, strength);
    }

    async executeInfluencerTrade(tokenSymbol, activity, signalStrength) {
        try {
            // Look up token in our database
            const token = await this.findTokenBySymbol(tokenSymbol);
            
            if (!token) {
                logger.warn(`Token ${tokenSymbol} not found in database`);
                return;
            }
            
            // Calculate position size based on signal strength
            const baseSize = parseFloat(process.env.MAX_POSITION_SIZE || 0.1);
            const multiplier = signalStrength / 100;
            const influencerMultiplier = this.getInfluencerMultiplier(activity.influencer);
            
            const positionSize = baseSize * multiplier * influencerMultiplier;
            
            logger.info(`🎯 Executing influencer-based trade:`, {
                token: tokenSymbol,
                influencer: activity.influencer,
                size: positionSize.toFixed(3),
                reason: 'influencer_signal'
            });
            
            // Execute via trading engine
            await this.tradingEngine.executeTrade(token, {
                confidence: signalStrength,
                strategy: 'influencer',
                metadata: {
                    influencer: activity.influencer,
                    platform: activity.platform,
                    sentiment: activity.sentiment
                }
            });
            
        } catch (error) {
            logger.error(`Failed to execute influencer trade for ${tokenSymbol}:`, error);
        }
    }

    async findTokenBySymbol(symbol) {
        // First check if it's a contract address
        if (symbol.length > 30) {
            const stmt = this.db.db.prepare('SELECT * FROM tokens WHERE address = ?');
            return stmt.get(symbol);
        }
        
        // Otherwise search by symbol
        const stmt = this.db.db.prepare('SELECT * FROM tokens WHERE symbol = ? ORDER BY liquidity DESC LIMIT 1');
        return stmt.get(symbol);
    }

    getInfluencerMultiplier(influencer) {
        const info = this.influencers.get(influencer);
        if (!info) return 1.0;
        
        const multipliers = {
            'S': 3.0,
            'A': 2.0,
            'B': 1.5,
            'C': 1.0
        };
        
        return multipliers[info.tier] || 1.0;
    }

    async storeInfluencerCall(activity, signalStrength) {
        try {
            const stmt = this.db.db.prepare(`
                INSERT INTO influencer_calls 
                (influencer, platform, tokens, sentiment, signal_strength, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run(
                activity.influencer,
                activity.platform,
                JSON.stringify(activity.tokens),
                activity.sentiment,
                signalStrength,
                activity.timestamp.toISOString()
            );
        } catch (error) {
            // Table might not exist yet, create it
            this.createInfluencerTable();
        }
    }

    createInfluencerTable() {
        this.db.db.exec(`
            CREATE TABLE IF NOT EXISTS influencer_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                influencer TEXT NOT NULL,
                platform TEXT NOT NULL,
                tokens TEXT,
                sentiment REAL,
                signal_strength REAL,
                timestamp DATETIME,
                outcome TEXT,
                profit_loss REAL
            )
        `);
    }

    async loadHistoricalPerformance() {
        try {
            const stmt = this.db.db.prepare(`
                SELECT influencer, 
                       COUNT(*) as total_calls,
                       SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_calls,
                       AVG(profit_loss) as avg_profit
                FROM influencer_calls
                WHERE outcome IS NOT NULL
                GROUP BY influencer
            `);
            
            const results = stmt.all();
            
            for (const result of results) {
                this.performanceHistory.set(result.influencer, {
                    totalCalls: result.total_calls,
                    winRate: result.winning_calls / result.total_calls,
                    avgProfit: result.avg_profit
                });
            }
        } catch (error) {
            // Performance history not critical for operation
        }
    }

    stopTracking() {
        this.isTracking = false;
        if (this.trackingTimer) {
            clearInterval(this.trackingTimer);
        }
        logger.info('Influencer tracking stopped');
    }
}

module.exports = InfluencerTracker;