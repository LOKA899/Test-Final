
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const skullManager = require('../utils/skullManager');
const supabase = require('../utils/supabaseClient');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('sb')
        .setDescription('Show all users\' skull balances'),

    async execute(interaction) {
        try {
            const { data: skullData, error } = await supabase
                .from('skulls')
                .select('user_id, balance')
                .order('balance', { ascending: false });

            if (error) throw error;

            if (!skullData || skullData.length === 0) {
                await interaction.reply({ 
                    content: 'No skull balances found.',
                    ephemeral: true 
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('💀 Skull Balances')
                .setColor('#FFD700');

            let description = '';
            for (const entry of skullData) {
                try {
                    const user = await interaction.client.users.fetch(entry.user_id);
                    description += `${user.displayName}: **${entry.balance}** skulls\n`;
                } catch (error) {
                    console.error(`Failed to fetch user ${entry.user_id}:`, error);
                    description += `Unknown User: **${entry.balance}** skulls\n`;
                }
            }

            embed.setDescription(description);
            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error fetching skull balances:', error);
            await interaction.reply({ 
                content: 'Failed to fetch skull balances.',
                ephemeral: true 
            });
        }
    },
};
