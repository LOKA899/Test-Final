const { SlashCommandBuilder } = require('@discordjs/builders');
const { lotteryManager } = require('../utils/lotteryManager');
const supabase = require('../utils/supabaseClient');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vl')
        .setDescription('View lottery winners by date')
        .addStringOption(option =>
            option.setName('date')
                .setDescription('Date in YYYY-MM-DD format')
                .setRequired(true)),

    async execute(interaction) {
        const dateStr = interaction.options.getString('date');
        
        try {
            // Convert and validate date format
            const formattedDate = dateStr.replace(/\//g, '-');
            const date = new Date(formattedDate);
            if (isNaN(date.getTime())) {
                await interaction.reply({
                    content: 'Invalid date format. Please use YYYY-MM-DD or YYYY/MM/DD',
                    ephemeral: true
                });
                return;
            }

            // Query Supabase for lotteries on that date
            const startOfDay = new Date(date.setHours(0, 0, 0, 0)).getTime();
            const endOfDay = new Date(date.setHours(23, 59, 59, 999)).getTime();

            console.log('Debug vl command:', {
                formattedDate,
                startOfDay,
                endOfDay,
                startDate: new Date(startOfDay).toISOString(),
                endDate: new Date(endOfDay).toISOString()
            });

            console.log('Checking all lotteries');
            const { data: lotteries, error } = await supabase
                .from('lotteries')
                .select('*')
                .not('winnerList', 'is', null);

            // Filter results in JS since timestamps might be stored differently
            const filteredLotteries = lotteries?.filter(lottery => {
                const lotteryDate = new Date(lottery.endTime);
                return lotteryDate >= new Date(startOfDay) && lotteryDate <= new Date(endOfDay);
            }) || [];

            console.log('Filtered lotteries:', filteredLotteries);

            console.log('Query result:', {
                hasData: !!lotteries,
                count: lotteries?.length || 0,
                error: error?.message
            });

            if (error) {
                console.error('Error fetching lotteries:', error);
                await interaction.reply({
                    content: 'Failed to fetch lottery data',
                    ephemeral: true
                });
                return;
            }

            if (!lotteries || lotteries.length === 0) {
                await interaction.reply({
                    content: `No completed lotteries found for ${dateStr}`,
                    ephemeral: true
                });
                return;
            }

            // Create embed for lottery winners
            const embed = {
                color: 0x0099ff,
                title: `Lottery Winners for ${dateStr}`,
                fields: [],
                footer: {
                    text: `Total Lotteries: ${lotteries.length}`
                }
            };

            // Add fields for each lottery
            for (const lottery of lotteries) {
                const winnerMentions = [];
                for (const winner of lottery.winnerList) {
                    try {
                        const user = await interaction.client.users.fetch(winner.id);
                        winnerMentions.push(user.toString());
                    } catch (error) {
                        winnerMentions.push('Unknown User');
                    }
                }

                embed.fields.push({
                    name: `Lottery #${lottery.id}`,
                    value: `Prize: ${lottery.prize}\nWinners: ${winnerMentions.join(', ') || 'None'}`
                });
            }

            await interaction.reply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('Error in viewlotterywinners command:', error);
            await interaction.reply({
                content: 'An error occurred while fetching lottery data',
                ephemeral: true
            });
        }
    }
};