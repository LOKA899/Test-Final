
const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cleanup')
        .setDescription('Clean up bot messages older than specified hours')
        .addIntegerOption(option =>
            option.setName('hours')
                .setDescription('Delete messages older than this many hours')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(720))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        const hours = interaction.options.getInteger('hours');
        const channel = interaction.channel;
        const clientId = interaction.client.user.id;

        await interaction.deferReply({ ephemeral: true });

        try {
            let deleted = 0;
            const messages = await channel.messages.fetch({ limit: 100 });
            const timeThreshold = Date.now() - (hours * 3600000);

            const botMessages = messages.filter(msg => 
                msg.author.id === clientId && 
                msg.createdTimestamp < timeThreshold
            );

            if (botMessages.size === 0) {
                await interaction.editReply(`No bot messages found older than ${hours} hours.`);
                return;
            }

            await channel.bulkDelete(botMessages);
            await interaction.editReply(`Successfully deleted ${botMessages.size} bot messages older than ${hours} hours.`);

        } catch (error) {
            console.error('Error cleaning up messages:', error);
            await interaction.editReply('An error occurred while cleaning up messages.');
        }
    },
};
