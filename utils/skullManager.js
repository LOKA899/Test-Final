const supabase = require('./supabaseClient');

class SkullManager {
    constructor() {}

    async getBalance(userId) {
        try {
            const { data, error } = await supabase
                .from('skulls')
                .select('balance')
                .eq('user_id', userId)
                .single();

            if (error) throw error;
            return data?.balance || 0;
        } catch (error) {
            console.error('Error getting balance:', error);
            return 0;
        }
    }

    async addSkulls(userId, amount) {
        try {
            const currentBalance = await this.getBalance(userId);
            const { data, error } = await supabase
                .from('skulls')
                .upsert({ 
                    user_id: userId, 
                    balance: currentBalance + amount 
                })
                .select()
                .single();

            if (error) throw error;
            return data.balance;
        } catch (error) {
            console.error('Error adding skulls:', error);
            throw error;
        }
    }

    async removeSkulls(userId, amount) {
        try {
            const currentBalance = await this.getBalance(userId);
            if (currentBalance < amount) {
                return false;
            }

            const { error } = await supabase
                .from('skulls')
                .update({ balance: currentBalance - amount })
                .eq('user_id', userId);

            if (error) throw error;
            return true;
        } catch (error) {
            console.error('Error removing skulls:', error);
            return false;
        }
    }

    async hasEnoughSkulls(userId, amount) {
        const balance = await this.getBalance(userId);
        return balance >= amount;
    }

    async transferSkulls(fromUserId, toUserId, amount) {
        const client = await supabase;
        try {
            const { error: checkError, data: fromBalance } = await client
                .from('skulls')
                .select('balance')
                .eq('user_id', fromUserId)
                .single();

            if (checkError || !fromBalance || fromBalance.balance < amount) {
                return false;
            }

            const { error: removeError } = await client
                .from('skulls')
                .update({ balance: fromBalance.balance - amount })
                .eq('user_id', fromUserId);

            if (removeError) throw removeError;

            const { error: addError } = await client
                .from('skulls')
                .upsert({ 
                    user_id: toUserId,
                    balance: amount 
                }, {
                    onConflict: 'user_id',
                    target: ['user_id'],
                    update: {
                        balance: supabase.raw(`skulls.balance + ${amount}`)
                    }
                });

            if (addError) throw addError;
            return true;
        } catch (error) {
            console.error('Transfer error:', error);
            return false;
        }
    }
}

module.exports = new SkullManager();