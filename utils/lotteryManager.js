const supabase = require('./supabaseClient');
const messageTemplates = require('./messageTemplates');
const { updateLotteryMessage } = require('./messageUpdater');
const { setTimeout, clearTimeout, setInterval, clearInterval } = require('timers');

class LotteryManager {
    constructor() {
        this.lotteries = new Map();
        this.timers = new Map();
        this.updateIntervals = new Map();
        this.client = null;
    }

    // Set the Discord client
    setClient(client) {
        this.client = client;
    }

    // Get a lottery by ID
    getLottery(lotteryId) {
        return this.lotteries.get(lotteryId);
    }

    getParticipantTickets(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery) return 0;
        return lottery.participants.get(userId) || 0;
    }

    getWinningProbability(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || !lottery.participants.has(userId)) return 0;

        const userTickets = this.getParticipantTickets(lotteryId, userId);
        if (lottery.totalTickets === 0) return 0;

        return (userTickets / lottery.totalTickets) * 100;
    }

    async addParticipant(lotteryId, userId, tickets = 1) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || lottery.status !== 'active') return false;

        // Check if user is already participating
        if (lottery.participants.has(userId)) return false;

        // Check max tickets per user
        if (tickets > lottery.maxTicketsPerUser) return false;

        // Add participant with their tickets
        lottery.participants.set(userId, tickets);
        lottery.totalTickets += tickets;

        // Update Supabase and track analytics
        await this.updateParticipantsInDatabase(lotteryId);
        const analyticsManager = require('./analyticsManager');
        await analyticsManager.trackParticipation(lotteryId, userId, 'join', tickets);

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

    removeParticipant(lotteryId, userId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || !lottery.participants.has(userId)) return false;

        const tickets = lottery.participants.get(userId);
        lottery.participants.delete(userId);
        lottery.totalTickets -= tickets;

        this.updateParticipantsInDatabase(lotteryId);
        return true;
    }


    // Create a new lottery
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
                participants: {},
                maxTicketsPerUser,
                ticketPrice,
                messageId: null,
                guildId,
                isManualDraw,
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


    // Update lottery status in Supabase
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

    // Handle failed lotteries (insufficient participants)
    async handleFailedLottery(lottery) {
        try {
            const channel = await this.client.channels.fetch(lottery.channelid);
            if (channel) {
                // Refund skulls to all participants
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

    // Set a timer for lottery end
    setTimer(lotteryId, duration) {
        if (this.timers.has(lotteryId)) {
            clearTimeout(this.timers.get(lotteryId));
        }
        const timer = setTimeout(() => this.endLottery(lotteryId), duration);
        this.timers.set(lotteryId, timer);
    }

    // Start message update interval
    startUpdateInterval(lottery) {
        if (this.updateIntervals.has(lottery.id)) {
            clearInterval(this.updateIntervals.get(lottery.id));
        }

        console.log(`[MessageUpdater] Starting update interval for lottery ${lottery.id}`);
        if (!lottery.messageId) {
            console.error(`[MessageUpdater] No messageId found for lottery ${lottery.id}`);
            return;
        }
        const updateFunc = async () => {
            try {
                const channel = await this.client.channels.fetch(lottery.channelid);
                if (!channel) {
                    console.error(`[MessageUpdater] Channel not found for lottery ${lottery.id}`);
                    return;
                }

                // Always attempt to update the message
                const { updateLotteryMessage } = require('./messageUpdater');

                // For expired manual lotteries, don't include buttons
                const includeButtons = lottery.status === 'active' || 
                    (lottery.isManualDraw && lottery.status === 'expired');

                await updateLotteryMessage(channel, lottery.messageId, lottery, includeButtons);

                // Only stop updates for ended or cancelled lotteries
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

    // Calculate update frequency based on remaining time
    calculateUpdateFrequency(endTime) {
        const remaining = endTime - Date.now();
        if (remaining <= -300000) return 30000; // Over 5 mins expired: 30s updates
        if (remaining <= 0) return 5000; // Recently expired: 5s updates
        if (remaining <= 60000) return 5000; // Last minute: 5s updates
        if (remaining <= 300000) return 15000; // Last 5 minutes: 15s
        return 30000; // Default: 30s
    }

    // End a lottery
    async endLottery(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || (lottery.status !== "active" && lottery.status !== "expired")) return;

        try {
            // Clear timer and update intervals
            if (this.timers.has(lotteryId)) {
                clearTimeout(this.timers.get(lotteryId));
                this.timers.delete(lotteryId);
            }

            // For manual draw lotteries, update status and maintain update interval
            if (lottery.isManualDraw) {
                lottery.status = "expired";
                const channel = await this.client.channels.fetch(lottery.channelid);
                if (channel) {
                    await channel.send(`⏰ The lottery for ${lottery.prize} has ended. Waiting for manual draw using /draw command.`);

                    // Ensure message updater is running
                    if (!this.updateIntervals.has(lottery.id)) {
                        this.startUpdateInterval(lottery);
                    }

                    const { updateLotteryMessage } = require('./messageUpdater');
                    await updateLotteryMessage(channel, lottery.messageId, lottery, true);
                }
                await this.updateStatus(lotteryId, "expired");
                return;
            }

            // For auto-draw lotteries, proceed with winner selection
            if (lottery.participants.size >= lottery.minParticipants) {
                const winners = await this.drawWinners(lotteryId);

                // Record winners in analytics
                const analyticsManager = require('./analyticsManager');
                await analyticsManager.recordWinners(lotteryId, winners);

                // Record final participation stats
                for (const [userId, tickets] of lottery.participants) {
                    await analyticsManager.trackParticipation(lotteryId, userId, 'complete', tickets);
                }

                await this.announceWinners(lottery, winners);
            } else {
                await this.handleFailedLottery(lottery);
            }

            await this.updateStatus(lotteryId, "ended");

            // Clear interval only after all updates are done
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

    // Draw winners for a lottery
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
            // Fetch user details before updating
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

    // Announce winners
    async announceWinners(lottery, winners) {
        try {
            const channel = await this.client.channels.fetch(lottery.channelid);
            if (!channel) return;

            // Update final message
            await updateLotteryMessage(channel, lottery.messageId, lottery, false);

            // Create userMentions map for winners and send DMs
            const userMentions = new Map();
            const notificationManager = require('./notificationManager');

            for (const winnerId of winners) {
                try {
                    const user = await this.client.users.fetch(winnerId);
                    userMentions.set(winnerId, user.toString());
                    // Send DM to winner
                    await notificationManager.notifyWinner(user, lottery, this.client);
                } catch (error) {
                    console.error(`Failed to fetch user ${winnerId}:`, error);
                    userMentions.set(winnerId, 'Unknown User');
                }
            }

            // Check if winners haven't been announced yet
            const { data } = await supabase
                .from("lotteries")
                .select("winnerAnnounced")
                .eq("id", lottery.id)
                .single();

            if (!data?.winnerAnnounced) {
                // Send winner announcement
                await channel.send({
                    embeds: [
                        messageTemplates.createWinnerEmbed(lottery, winners, userMentions),
                        messageTemplates.createCongratulationsEmbed(lottery.prize, winners, userMentions)
                    ]
                });

                // Update Supabase
                await supabase
                    .from("lotteries")
                    .update({ winnerAnnounced: true })
                    .eq("id", lottery.id);
            }
        } catch (error) {
            console.error(`Error announcing winners for ${lottery.id}:`, error);
        }
    }

    // Restore active lotteries on bot start
    async getAllActiveLotteries() {
        try {
            const now = Date.now();
            const { data: lotteries, error } = await supabase
                .from("lotteries")
                .select("*")
                .or(`status.eq.active,status.eq.expired,endTime.gt.${now - 300000}`); // Include expired lotteries

            if (error) throw error;

            const restoredLotteries = [];

            for (const lotteryData of lotteries) {
                try {
                    console.log(`[Restoration] Processing lottery ${lotteryData.id}`);

                    // Convert participants to Map
                    lotteryData.participants = new Map(
                        Object.entries(lotteryData.participants || {})
                    );

                    // Validate critical fields
                    if (!lotteryData.channelid || !lotteryData.messageId) {
                        console.error(`[Restoration] Skipping lottery ${lotteryData.id} - Missing channel/message ID`);
                        await this.updateStatus(lotteryData.id, "ended");
                        continue;
                    }

                    // Check lottery status conditions
                    const isExpired = lotteryData.endTime <= now;
                    const shouldBeActive = !isExpired && lotteryData.status === "active";
                    const shouldRestore = shouldBeActive || 
                        (lotteryData.isManualDraw && lotteryData.status === "expired") ||
                        (isExpired && lotteryData.status === "active");

                    if (shouldRestore) {
                        console.log(`[Restoration] Reinitializing lottery ${lotteryData.id}`);

                        // Store in memory
                        this.lotteries.set(lotteryData.id, lotteryData);

                        // Handle expired active lottery
                        if (isExpired && lotteryData.status === "active") {
                            if (lotteryData.isManualDraw) {
                                console.log(`[Restoration] Setting manual draw lottery ${lotteryData.id} to expired`);
                                lotteryData.status = "expired";
                                await this.updateStatus(lotteryData.id, "expired");
                                // Store before starting interval
                                this.lotteries.set(lotteryData.id, lotteryData);
                                // Start update interval for expired manual lottery
                                this.startUpdateInterval(lotteryData);
                            } else {
                                console.log(`[Restoration] Ending expired auto-draw lottery ${lotteryData.id}`);
                                await this.endLottery(lotteryData.id);
                                continue;
                            }
                        }

                        // For manual draw expired lotteries, notify admin
                        if (lotteryData.isManualDraw && lotteryData.status === "expired") {
                            const channel = await this.client.channels.fetch(lotteryData.channelid);
                            if (channel) {
                                try {
                                    const admin = await this.client.users.fetch(lotteryData.createdBy);
                                    await admin.send(`⚠️ Manual draw lottery ${lotteryData.id} (${lotteryData.prize}) has been restored and is waiting for draw.`);
                                } catch (error) {
                                    console.error(`Failed to notify admin for lottery ${lotteryData.id}:`, error);
                                }
                            }
                        }

                        // Start message updater for active and expired manual draw lotteries
                        this.startUpdateInterval(lotteryData);

                        // Set timer only for active non-manual lotteries
                        if (shouldBeActive && !lotteryData.isManualDraw) {
                            const remainingTime = lotteryData.endTime - now;
                            this.setTimer(lotteryData.id, remainingTime);
                        }

                        restoredLotteries.push(lotteryData);
                    } else if (lotteryData.status === "active") {
                        console.log(`[Restoration] Handling expired active lottery ${lotteryData.id}`);
                        await this.endLottery(lotteryData.id);
                    }
                } catch (error) {
                    console.error(`[Restoration] Error processing lottery ${lotteryData.id}:`, error);
                }
            }

            console.log(`[Restoration] Successfully restored ${restoredLotteries.length} lotteries`);
            return restoredLotteries;
        } catch (error) {
            console.error("[Restoration] Error fetching lotteries:", error);
            return [];
        }
    }

    async cancelLottery(lotteryId) {
        const lottery = this.getLottery(lotteryId);
        if (!lottery || (lottery.status !== "active" && lottery.status !== "expired")) return false;

        try {
            // Handle refunds for participants
            for (const [userId, tickets] of lottery.participants) {
                const refundAmount = tickets * lottery.ticketPrice;
                if (refundAmount > 0) {
                    const skullManager = require('./skullManager');
                    await skullManager.addSkulls(userId, refundAmount);
                    try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(`Your ${refundAmount} skulls have been refunded for lottery ${lottery.id} (${lottery.prize}) due to cancellation.`);
                    } catch (error) {
                        console.error(`Failed to DM user ${userId} about refund:`, error);
                    }
                }
            }

            // Update lottery status
            await this.updateStatus(lotteryId, "cancelled");
            lottery.status = "cancelled";

            // Clear any active timers
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