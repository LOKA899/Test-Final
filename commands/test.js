
const { SlashCommandBuilder } = require('@discordjs/builders');
const supabase = require('../utils/supabaseClient');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('Test database connection'),
    async execute(interaction) {
        await interaction.deferReply();
        try {
            const { data, error } = await supabase
                .from('skulls')
                .select('*', { count: 'exact' });
                
            if (error) throw error;
            
            await interaction.editReply({
                content: '✅ Successfully connected to Supabase!'
            });
        } catch (error) {
            console.error('Database connection error:', error);
            await interaction.editReply({
                content: '❌ Failed to connect to database. Error: ' + error.message
            });
        }
    }
};
