
const messageTemplates = require('./messageTemplates');
const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

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
        
        const components = [];
        if (includeButtons && lottery.status === 'active') {
            components.push(createActionRow(lottery.id));
        }

        // Only stop updates for ended or cancelled lotteries
        // Keep updating expired manual lotteries
        if ((lottery.status === 'ended' || lottery.status === 'cancelled') ||
            (lottery.status === 'expired' && !lottery.isManualDraw)) {
            if (lottery.updateIntervals?.has(lottery.id)) {
                clearInterval(lottery.updateIntervals.get(lottery.id));
                lottery.updateIntervals.delete(lottery.id);
            }
        }

        await message.edit({
            embeds: [updatedEmbed],
            components: components
        });

        console.log(`[Update] Successfully updated message for lottery ${lottery.id} (Status: ${lottery.status})`);
        return true;
    } catch (error) {
        console.error(`[Update] Error updating message for lottery ${lottery.id}:`, error);
        return false;
    }
}

module.exports = {
    updateLotteryMessage,
    createActionRow
};
