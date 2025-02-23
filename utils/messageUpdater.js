
const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const messageTemplates = require('./messageTemplates');

const embedUpdateIntervals = new Map();

function startEmbedUpdateTimer(channel, messageId, lottery, includeButtons) {
    if (embedUpdateIntervals.has(messageId)) {
        clearInterval(embedUpdateIntervals.get(messageId));
    }

    const interval = setInterval(async () => {
        try {
            await updateLotteryMessage(channel, messageId, lottery, includeButtons);
            
            if (lottery.status === 'ended' || lottery.status === 'cancelled') {
                clearInterval(embedUpdateIntervals.get(messageId));
                embedUpdateIntervals.delete(messageId);
            }
        } catch (error) {
            console.error(`[EmbedUpdate] Error updating embed for lottery ${lottery.id}:`, error);
            clearInterval(embedUpdateIntervals.get(messageId));
            embedUpdateIntervals.delete(messageId);
        }
    }, 1000); // Update every second

    embedUpdateIntervals.set(messageId, interval);
}

function createActionRow(lotteryId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`join_${lotteryId}`)
            .setLabel("🎟️ Join Lottery")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`view_${lotteryId}`)
            .setLabel("👥 View Participants")
            .setStyle(ButtonStyle.Secondary)
    );
}

async function updateLotteryMessage(channel, messageId, lottery, includeButtons = true) {
    try {
        const message = await channel.messages.fetch(messageId);
        const updatedEmbed = messageTemplates.createLotteryEmbed(lottery);

        // Start embed update timer if not already running
        if (!embedUpdateIntervals.has(messageId) && lottery.status === 'active') {
            startEmbedUpdateTimer(channel, messageId, lottery, includeButtons);
        }
        
        const components = [];
        if (includeButtons && lottery.status === 'active') {
            components.push(createActionRow(lottery.id));
        }

        if (lottery.status === 'expired' && lottery.isManualDraw) {
            components.length = 0;
        }

        const currentEmbed = message.embeds[0];
        const needsUpdate = !currentEmbed || 
            currentEmbed.data.description !== updatedEmbed.data.description ||
            JSON.stringify(currentEmbed.data.fields) !== JSON.stringify(updatedEmbed.data.fields);

        if (needsUpdate) {
            await message.edit({
                embeds: [updatedEmbed],
                components: components
            });
            console.log(`[Update] Successfully updated message for lottery ${lottery.id}`);
        }
        return true;
    } catch (error) {
        console.error(`[Update] Error updating message for lottery ${lottery.id}:`, error);
        return false;
    }
}

module.exports = {
    updateLotteryMessage,
    createActionRow,
    startEmbedUpdateTimer
};
