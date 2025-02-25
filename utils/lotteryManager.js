const supabase = require('./supabaseClient');
const messageTemplates = require('./messageTemplates');
const { updateLotteryMessage } = require('./messageUpdater');
const { setTimeout, clearTimeout, setInterval, clearInterval } = require('timers');
const skullManager = require('./skullManager');

class LotteryManager {
    constructor() {
        this.lotteries = new Map();
        this.timers = new Map();
        this.updateIntervals = new Map();
        this.expirationChecks = new Map();
        this.client = null;
    }

    getParticipantTickets(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || !lottery.participants.has(userId)) return 0;
        return lottery.participants.get(userId);
    }

    getWinningProbability(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || !lottery.participants.has(userId)) return 0;

        const userTickets = this.getParticipantTickets(lotteryId, userId);
        return (userTickets / lottery.totalTickets) * 100 * lottery.winners;
    }

    setClient(client) {
        this.client = client;
    }

    getLottery(lotteryId) {
        return this.lotteries.get(lotteryId);
    }
    
    setTimer(lotteryId, duration) {
        if (this.timers.has(lotteryId)) {
            clearTimeout(this.timers.get(lotteryId));
        }
        const timer = setTimeout(() => this.endLottery(lotteryId), duration);
        this.timers.set(lotteryId, timer);
    }
    
    async createLottery({ prize, winners, minParticipants, duration, createdBy, channelId, guildId, isManualDraw = false, ticketPrice = 0, maxTicketsPerUser = 1, terms = null }) {
        try {
            const id = Date.now().toString();
            const startTime = Date.now();
            const endTime = startTime + duration;

            const lottery = {
                id,
                prize,
                winners: parseInt(winners),
                minParticipants: minParticipants || winners,
                terms,
                startTime,
                endTime,
                participants: new Map(),
                maxTicketsPerUser,
                ticketPrice,
                messageId: null,
                guildId,
                isManualDraw: false, // Start with false, will be set later
                status: 'active',
                createdBy,
                totalTickets: 0,
                winnerList: [],
                channelid: channelId,
                israffle: false
            };

            const { error } = await supabase
                .from("lotteries")
                .insert([lottery]);

            if (error) throw error;

            lottery.participants = new Map(Object.entries(lottery.participants));
            this.lotteries.set(id, lottery);

            if (!lottery.isManualDraw) {
                this.setTimer(id, duration);
            }

            return lottery;
        } catch (error) {
            console.error("Error creating lottery:", error);
            throw error;
        }
    }

    async addParticipant(lotteryId, userId, tickets = 1) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || lottery.status !== 'active') return false;

        if (lottery.participants.has(userId)) return false;

        if (tickets > lottery.maxTicketsPerUser) return false;

        lottery.participants.set(userId, tickets);
        lottery.totalTickets += tickets;
        
        // Force an immediate message update
        const channel = await this.client.channels.fetch(lottery.channelid);
        if (channel) {
            await updateLotteryMessage(channel, lottery.messageId, lottery, true);
        }

        await this.updateParticipantsInDatabase(lotteryId);
        const analyticsManager = require('./analyticsManager');
        await analyticsManager.trackParticipation(lotteryId, userId, 'join', tickets);

        return true;
    }

    async removeParticipant(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || !lottery.participants.has(userId)) return false;

        const tickets = lottery.participants.get(userId);
        lottery.participants.delete(userId);
        lottery.totalTickets -= tickets;
        
        await this.updateParticipantsInDatabase(lotteryId);
        const channel = await this.client.channels.fetch(lottery.channelid);
        if (channel) {
            const { updateLotteryMessage } = require('./messageUpdater');
            await updateLotteryMessage(channel, lottery.messageId, lottery, true);
        }

        return true;
    }

    async updateParticipantsInDatabase(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery) return;

        try {
            const participantsObj = Object.fromEntries(lottery.participants);
            await supabase
                .from("lotteries")
                .update({ 
                    participants: participantsObj,
                    totalTickets: lottery.totalTickets
                })
                .eq("id", lotteryId);
        } catch (error) {
            console.error("Error updating participants in database:", error);
        }
    }

    async getAllActiveLotteries() {
        try {
            const now = Date.now();
            const { data: lotteries, error } = await supabase
                .from("lotteries")
                .select("*")
                .or(`status.eq.active,status.eq.expired,endTime.gt.${now - 300000}`);

            if (error) throw error;

            const restoredLotteries = [];

            for (const lotteryData of lotteries) {
                try {
                    console.log(`[Restoration] Processing lottery ${lotteryData.id}`);

                    lotteryData.participants = new Map(
                        Object.entries(lotteryData.participants || {})
                    );

                    if (lotteryData.endTime <= now) {
                        if (lotteryData.status === "active") {
                            if (lotteryData.isManualDraw) {
                                await this.handleManualExpiration(lotteryData);
                                continue;
                            } else {
                                await this.endLottery(lotteryData.id);
                                continue;
                            }
                        }
                    }

                    if (lotteryData.channelid && lotteryData.messageId) {
                        this.lotteries.set(lotteryData.id, lotteryData);
                        this.startUpdateInterval(lotteryData);

                        if (lotteryData.status === "active") {
                            if (lotteryData.isManualDraw) {
                                this.startExpirationCheck(lotteryData);
                            } else {
                                const remainingTime = lotteryData.endTime - Date.now();
                                if (remainingTime > 0) {
                                    this.setTimer(lotteryData.id, remainingTime);
                                } else {
                                    this.endLottery(lotteryData.id);
                                }
                            }
                        }

                        restoredLotteries.push(lotteryData);
                    }
                } catch (error) {
                    console.error(`[Restoration] Error processing lottery ${lotteryData.id}:`, error);
                }
            }
            return restoredLotteries;
        } catch (error) {
            console.error("[Restoration] Error:", error);
            return [];
        }
    }

    async startUpdateInterval(lottery) {
        if (this.updateIntervals.has(lottery.id)) {
            clearInterval(this.updateIntervals.get(lottery.id));
            this.updateIntervals.delete(lottery.id);
        }

        console.log(`[MessageUpdater] Starting update interval for lottery ${lottery.id}`);
        if (!lottery.messageId) {
            console.error(`[MessageUpdater] No messageId found for lottery ${lottery.id}`);
            return;
        }

        // Force immediate update
        const { updateLotteryMessage } = require('./messageUpdater');
        const channel = await this.client.channels.fetch(lottery.channelid);
        if (channel) {
            await updateLotteryMessage(channel, lottery.messageId, lottery, true);
        }

        const updateFunc = async () => {
            try {
                const channel = await this.client.channels.fetch(lottery.channelid);
                if (!channel) {
                    console.error(`[MessageUpdater] Channel not found for lottery ${lottery.id}`);
                    return;
                }

                const includeButtons = lottery.status === 'active' || 
                    (lottery.isManualDraw && lottery.status === 'expired');

                await updateLotteryMessage(channel, lottery.messageId, lottery, includeButtons);

                if (lottery.status === 'ended' || lottery.status === 'cancelled') {
                    console.log(`[MessageUpdater] Stopping updates for ${lottery.id} (${lottery.status})`);
                    if (this.updateIntervals.has(lottery.id)) {
                        clearInterval(this.updateIntervals.get(lottery.id));
                        this.updateIntervals.delete(lottery.id);
                    }
                }
            } catch (error) {
                console.error(`[MessageUpdater] Failed to update message for lottery ${lottery.id}:`, error);
                if (this.updateIntervals.has(lottery.id)) {
                    clearInterval(this.updateIntervals.get(lottery.id));
                    this.updateIntervals.delete(lottery.id);
                }
            }
        };

        const updateFrequency = this.calculateUpdateFrequency(lottery.endTime);
        const interval = setInterval(updateFunc, updateFrequency);
        this.updateIntervals.set(lottery.id, interval);
        updateFunc(); // Immediate first update
    }

    calculateUpdateFrequency(endTime) {
        const remaining = endTime - Date.now();
        if (remaining <= -300000) return 30000; // Over 5 mins expired: 30s updates
        if (remaining <= 0) return 5000; // Recently expired: 5s updates
        if (remaining <= 60000) return 5000; // Last minute: 5s updates
        if (remaining <= 300000) return 15000; // Last 5 minutes: 15s
        return 30000; // Default: 30s
    }

    startExpirationCheck(lottery) {
        if (this.expirationChecks.has(lottery.id)) {
            clearInterval(this.expirationChecks.get(lottery.id));
        }

        const checkExpiration = async () => {
            if (Date.now() > lottery.endTime && lottery.status === "active") {
                await this.handleManualExpiration(lottery);
            }
        };

        checkExpiration();
        const interval = setInterval(checkExpiration, 30000);
        this.expirationChecks.set(lottery.id, interval);
    }

    async handleManualExpiration(lottery) {
        try {
            if (!lottery.isManualDraw || lottery.status !== "active") {
                return;
            }
            
            lottery.status = "expired";
            await this.updateStatus(lottery.id, "expired");

            const channel = await this.client.channels.fetch(lottery.channelid);
            if (channel) {
                await updateLotteryMessage(channel, lottery.messageId, lottery, true);
            }

            await this.notifyManualExpiration(lottery);
            
            // Clear any existing timers
            if (this.timers.has(lottery.id)) {
                clearTimeout(this.timers.get(lottery.id));
                this.timers.delete(lottery.id);
            }
        } catch (error) {
            console.error(`Error handling manual expiration for ${lottery.id}:`, error);
        }
    }

    async notifyManualExpiration(lottery) {
        try {
            const admin = await this.client.users.fetch(lottery.createdBy);
            await admin.send({
                content: `⚠️ **Manual Draw Required**\n` +
                         `Lottery ID: \`${lottery.id}\`\n` +
                         `Prize: ${lottery.prize}\n` +
                         `Channel: <#${lottery.channelid}>\n\n` +
                         `Use \`/draw ${lottery.id}\` to select winners`
            });
        } catch (error) {
            console.error(`Failed to DM admin for lottery ${lottery.id}:`, error);

            const channel = await this.client.channels.fetch(lottery.channelid);
            if (channel) {
                await channel.send({
                    content: `⚠️ <@${lottery.createdBy}> ` +
                             `Manual draw required for lottery \`${lottery.id}\`!\n` +
                             `Use \`/draw ${lottery.id}\` to select winners.`
                });
            }
        }
    }

    async updateStatus(lotteryId, status) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery) return;

        try {
            const { error } = await supabase
                .from("lotteries")
                .update({ status })
                .eq("id", lotteryId);

            if (error) throw error;
            lottery.status = status;
        } catch (error) {
            console.error("Error updating status:", error);
        }
    }

    async endLottery(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || (lottery.status !== "active" && lottery.status !== "expired")) return;

        try {
            if (this.timers.has(lotteryId)) {
                clearTimeout(this.timers.get(lotteryId));
                this.timers.delete(lotteryId);
            }

            if (lottery.participants.size >= lottery.minParticipants) {
                const winners = await this.drawWinners(lotteryId);
                if (winners && winners.length > 0) {
                    await this.announceWinners(lottery, winners);
                } else {
                    await this.handleFailedLottery(lottery);
                }
            } else {
                await this.handleFailedLottery(lottery);
            }

            await this.updateStatus(lotteryId, "ended");

            if (this.updateIntervals.has(lotteryId)) {
                clearInterval(this.updateIntervals.get(lotteryId));
                this.updateIntervals.delete(lotteryId);
            }
        } catch (error) {
            console.error(`Error ending lottery ${lotteryId}:`, error);
            await this.updateStatus(lotteryId, "ended");

            if (this.updateIntervals.has(lotteryId)) {
                clearInterval(this.updateIntervals.get(lotteryId));
                this.updateIntervals.delete(lotteryId);
            }
        }
    }

    async drawWinners(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || (lottery.status !== "active" && lottery.status !== "expired")) return [];

        const winners = new Set();
        const ticketPool = [];

        for (const [userId, tickets] of lottery.participants) {
            for (let i = 0; i < tickets; i++) {
                ticketPool.push(userId);
            }
        }

        while (winners.size < lottery.winners && ticketPool.length > 0) {
            const index = Math.floor(Math.random() * ticketPool.length);
            winners.add(ticketPool[index]);
            ticketPool.splice(index, 1);
        }

        const winnerArray = Array.from(winners);
        lottery.winnerList = winnerArray;

        try {
            const winnerDetails = await Promise.all(
                winnerArray.map(async (id) => {
                    try {
                        const user = await this.client.users.fetch(id);
                        return {
                            id,
                            username: user.username,
                            displayName: user.displayName || user.username
                        };
                    } catch (error) {
                        console.error(`Failed to fetch user ${id}:`, error);
                        return { id, username: "Unknown User", displayName: "Unknown User" };
                    }
                })
            );

            const { error } = await supabase
                .from("lotteries")
                .update({
                    status: "ended",
                    winnerList: winnerDetails
                })
                .eq("id", lotteryId);

            if (error) throw error;
            return winnerArray;
        } catch (error) {
            console.error("Error updating winners:", error);
            throw error;
        }
    }

    async announceWinners(lottery, winners) {
        try {
            const channel = await this.client.channels.fetch(lottery.channelid);
            if (!channel) return;

            await updateLotteryMessage(channel, lottery.messageId, lottery, false);

            const userMentions = new Map();
            const notificationManager = require('./notificationManager');

            for (const winnerId of winners) {
                try {
                    const user = await this.client.users.fetch(winnerId);
                    userMentions.set(winnerId, user.toString());
                    const notified = await notificationManager.notifyWinner(user, lottery, this.client);
                    if (!notified) {
                        console.warn(`Could not send DM to winner ${user.tag} (${winnerId})`);
                    }
                } catch (error) {
                    console.error(`Failed to fetch user ${winnerId}:`, error);
                    userMentions.set(winnerId, 'Unknown User');
                }
            }

            const { data } = await supabase
                .from("lotteries")
                .select("winnerAnnounced")
                .eq("id", lottery.id)
                .single();

            if (!data?.winnerAnnounced) {
                await channel.send({
                    embeds: [
                        messageTemplates.createWinnerEmbed(lottery, winners, userMentions),
                        messageTemplates.createCongratulationsEmbed(lottery.prize, winners, userMentions)
                    ]
                });

                await supabase
                    .from("lotteries")
                    .update({ winnerAnnounced: true })
                    .eq("id", lottery.id);
            }
        } catch (error) {
            console.error(`Error announcing winners for ${lottery.id}:`, error);
        }
    }

    async handleFailedLottery(lottery) {
        try {
            const channel = await this.client.channels.fetch(lottery.channelid);
            if (channel) {
                for (const [userId, tickets] of lottery.participants) {
                    const refundAmount = tickets * lottery.ticketPrice;
                    if (refundAmount > 0) {
                        await skullManager.addSkulls(userId, refundAmount);
                        try {
                            const user = await this.client.users.fetch(userId);
                            await user.send(`Your ${refundAmount} skulls have been refunded for lottery ${lottery.id} (${lottery.prize}) due to insufficient participants.`);
                        } catch (error) {
                            console.error(`Failed to DM user ${userId} about refund:`, error);
                        }
                    }
                }

                await channel.send(
                    `⚠️ Lottery ${lottery.id} for ${lottery.prize} has ended without winners due to insufficient participants (${lottery.participants.size}/${lottery.minParticipants} required). All participants have been refunded.`
                );
            }
        } catch (error) {
            console.error("Error handling failed lottery:", error);
        }
    }

    async cancelLottery(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || (lottery.status !== "active" && lottery.status !== "expired")) return false;

        try {
            for (const [userId, tickets] of lottery.participants) {
                const refundAmount = tickets * lottery.ticketPrice;
                if (refundAmount > 0) {
                    await skullManager.addSkulls(userId, refundAmount);
                    try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(`Your ${refundAmount} skulls have been refunded for lottery ${lottery.id} (${lottery.prize}) due to cancellation.`);
                    } catch (error) {
                        console.error(`Failed to DM user ${userId} about refund:`, error);
                    }
                }
            }

            await this.updateStatus(lotteryId, "cancelled");
            lottery.status = "cancelled";

            if (this.timers.has(lotteryId)) {
                clearTimeout(this.timers.get(lotteryId));
                this.timers.delete(lotteryId);
            }
            if (this.updateIntervals.has(lotteryId)) {
                clearInterval(this.updateIntervals.get(lotteryId));
                this.updateIntervals.delete(lotteryId);
            }

            return true;
        } catch (error) {
            console.error("Error cancelling lottery:", error);
            return false;
        }
    }
}

const lotteryManagerInstance = new LotteryManager();

module.exports = {
    LotteryManager,
    lotteryManager: lotteryManagerInstance
};