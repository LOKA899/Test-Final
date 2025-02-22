const supabase = require('./supabaseClient');

class DataManager {
    constructor() {}

    async saveData(table, data) {
        try {
            const { error } = await supabase
                .from(table)
                .upsert(data);

            if (error) throw error;
            console.log(`✅ Data saved to ${table}`);
        } catch (error) {
            console.error(`❌ Error saving to ${table}:`, error);
            throw error;
        }
    }

    async loadData(table) {
        try {
            const { data, error } = await supabase
                .from(table)
                .select('*');

            if (error) throw error;
            return data;
        } catch (error) {
            console.error(`❌ Error loading from ${table}:`, error);
            return null;
        }
    }
}

module.exports = new DataManager();