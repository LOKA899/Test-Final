
const { lotteryManager } = require('./lotteryManager');

module.exports = {
    getLottery: (lotteryId) => lotteryManager.getLottery(lotteryId)
};
