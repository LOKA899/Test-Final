
const { SlashCommandBuilder } = require('@discordjs/builders');
const { lotteryManager } = require('../utils/lotteryManager');
const messageTemplates = require('../utils/messageTemplates');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vp')
        .setDescription('View participants of a lottery')
        .addStringOption(option =>
            option.setName('lottery_id')
                .setDescription('ID of the lottery')
                .setRequired(true)),

    async execute(interaction) {
        const lotteryId = interaction.options.getString('lottery_id');
        
        // Get lottery from manager
        const lottery = lotteryManager.getLottery(lotteryId);
        
        if (!lottery) {
            await interaction.reply({
                content: 'Lottery not found!',
                ephemeral: true
            });
            return;
        }

        // Get participant mentions
        const participantMentions = [];
        for (const [participantId] of lottery.participants) {
            try {
                const user = await interaction.client.users.fetch(participantId);
                participantMentions.push(user.toString());
            } catch (error) {
                console.error(`Failed to fetch user ${participantId}:`, error);
                participantMentions.push("Unknown User");
            }
        }

        // Create simple embed
        const embed = {
            color: 0x0099ff,
            title: `Participants for Lottery #${lotteryId}`,
            description: participantMentions.length > 0 
                ? participantMentions.join('\n')
                : 'No participants yet',
            footer: {
                text: `Total Participants: ${participantMentions.length}`
            }
        };

        await interaction.reply({ 
            embeds: [embed],
            ephemeral: true
        });
    }
};
