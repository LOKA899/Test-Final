const { ButtonInteraction, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { lotteryManager } = require('./lotteryManager');
const messageTemplates = require('./messageTemplates');
const notificationManager = require('./notificationManager');
const skullManager = require('./skullManager');
const supabase = require('./supabaseClient');
const { updateLotteryMessage } = require('./messageUpdater');

async function handleButton(interaction) {
    const [action, lotteryId, quantity, type] = interaction.customId.split('_');

    try {
        switch (action) {
            case 'wallet':
                await handleWalletSubmission(interaction, lotteryId, type);
                break;
            case 'ticket':
                await handleTicketSelection(interaction, lotteryId, parseInt(quantity));
                break;
            case 'confirm':
                await handleConfirmLottery(interaction, lotteryId);
                break;
            case 'cancel':
                await handleCancelLottery(interaction, lotteryId);
                break;
            case 'join':
                await handleJoinLottery(interaction, lotteryId);
                break;
            case 'view':
                await handleViewParticipants(interaction, lotteryId);
                break;
            case 'auto':
                await handleAutoDrawSetting(interaction, lotteryId);
                break;
            case 'manual':
                await handleManualDrawSetting(interaction, lotteryId);
                break;
        }
    } catch (error) {
        console.error('Button interaction error:', error);
        const response = {
            content: 'There was an error processing your request. Please try again.',
            ephemeral: true
        };

        try {
            if (interaction.replied) {
                await interaction.followUp(response);
            } else if (interaction.deferred) {
                await interaction.editReply(response);
            } else {
                await interaction.reply(response);
            }
        } catch (err) {
            console.error('Failed to send error response:', err);
        }
    }
}

async function handleConfirmLottery(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId);
    if (!lottery) {
        await interaction.reply({
            content: "Lottery not found!",
            ephemeral: true,
        });
        return;
    }

    if (lottery.isManualDraw === undefined) {
        await interaction.reply({
            content: "Please select a draw method (Auto or Manual) before confirming.",
            ephemeral: true,
        });
        return;
    }

    const embed = messageTemplates.createLotteryEmbed(lottery);

    const joinButton = new ButtonBuilder()
        .setCustomId(`join_${lottery.id}`)
        .setLabel("🎟️ Join Lottery")
        .setStyle(ButtonStyle.Primary);

    const viewButton = new ButtonBuilder()
        .setCustomId(`view_${lottery.id}`)
        .setLabel("👥 View Participants")
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(joinButton, viewButton);

    const message = await interaction.channel.send({
        embeds: [embed],
        components: [row],
    });

    lottery.channelid = interaction.channel.id;
    lottery.messageId = message.id;

    const { error } = await supabase
        .from("lotteries")
        .update({
            status: "active",
            isManualDraw: lottery.isManualDraw,
            channelid: interaction.channel.id,
            messageId: message.id,
        })
        .eq("id", lottery.id);

    if (error) {
        await interaction.reply({
            content: "Failed to update lottery status. Please try again.",
            ephemeral: true,
        });
        return;
    }

    lottery.status = "active";

    await notificationManager.scheduleEndingSoonNotification(lottery, interaction.client);

    await interaction.update({
        content: "Lottery started successfully!",
        embeds: [],
        components: [],
    });

    if (!lottery.isManualDraw) {
        setTimeout(async () => {
            if (lottery.status === "active") {
                const channel = await interaction.client.channels.fetch(lottery.channelid);
                if (!channel) {
                    await lotteryManager.cancelLottery(lotteryId);
                    await lotteryManager.updateStatus(lotteryId, "ended");
                    return;
                }

                if (lottery.participants.size >= lottery.minParticipants) {
                    const winners = await lotteryManager.drawWinners(lotteryId);
                    if (channel) {
                        lottery.status = "ended";
                        await updateLotteryMessage(channel, lottery.messageId, lottery, false);
                    }

                    if (winners && winners.length > 0) {
                        await lotteryManager.announceWinners(lottery, winners);
                    } else {
                        await lotteryManager.handleFailedLottery(lottery);
                    }
                } else {
                    await lotteryManager.handleFailedLottery(lottery);
                }

                await lotteryManager.updateStatus(lotteryId, "ended");
            }
        }, lottery.endTime - Date.now());
    } else {
        lotteryManager.startExpirationCheck(lottery);
    }
}

async function handleViewParticipants(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId);
    if (!lottery || lottery.status !== "active") {
        await interaction.reply({
            content: "This lottery is not active!",
            ephemeral: true,
        });
        return;
    }

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

    const embed = messageTemplates.createParticipantsEmbed(lottery, participantMentions);
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAutoDrawSetting(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId); 
    if (!lottery) {
        await interaction.reply({ content: 'Lottery not found!', ephemeral: true });
        return;
    }

    lottery.isManualDraw = false;
    await interaction.reply({ 
        content: 'Auto draw enabled. Winners will be automatically selected when the timer ends.',
        ephemeral: true
    });
}

async function handleManualDrawSetting(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId); 
    if (!lottery) {
        await interaction.reply({ content: 'Lottery not found!', ephemeral: true });
        return;
    }

    lottery.isManualDraw = true;

    // Stop any auto-draw timers
    if (lotteryManager.timers.has(lottery.id)) {
        clearTimeout(lotteryManager.timers.get(lottery.id));
        lotteryManager.timers.delete(lottery.id);
    }

    // Start expiration check for manual draw
    lotteryManager.startExpirationCheck(lottery);

    await interaction.reply({ 
        content: 'Manual draw enabled. Use /draw command to select winners when ready.',
        ephemeral: true
    });
}

async function handleCancelLottery(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId);
    if (!lottery) {
        await interaction.reply({
            content: "Lottery not found!",
            ephemeral: true,
        });
        return;
    }

    lotteryManager.cancelLottery(lotteryId);
    await interaction.update({
        content: "Lottery cancelled.",
        embeds: [],
        components: [],
    });
}

async function handleWalletSubmission(interaction, lotteryId, walletType) {
    const modal = new ModalBuilder()
        .setCustomId(`wallet_submit_${lotteryId}_${walletType}`)
        .setTitle(`Submit ${walletType} Wallet Address`);

    const walletInput = new TextInputBuilder()
        .setCustomId('wallet_address')
        .setLabel('Enter your wallet address')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const firstActionRow = new ActionRowBuilder().addComponents(walletInput);
    modal.addComponents(firstActionRow);
    await interaction.showModal(modal);
}

async function handleJoinLottery(interaction, lotteryId) {
    const lottery = lotteryManager.getLottery(lotteryId);
    if (!lottery || lottery.status !== "active") {
        await interaction.reply({
            content: "This lottery is not active!",
            ephemeral: true,
        });
        return;
    }

    if (lottery.ticketPrice > 0) {
        if (!await skullManager.hasEnoughSkulls(interaction.user.id, lottery.ticketPrice)) {
            await interaction.reply({
                content: `You don't have enough skulls to join this lottery. Required: ${lottery.ticketPrice} skulls per ticket. Use /skulls balance to check your balance.`,
                ephemeral: true,
            });
            return;
        }
    }

    if (lottery.ticketPrice > 0) {
        const maxAffordableTickets = Math.floor(
            await skullManager.getBalance(interaction.user.id) / lottery.ticketPrice
        );
        const actualMaxTickets = Math.min(maxAffordableTickets, lottery.maxTicketsPerUser);

        const buttons = [];
        for (let i = 1; i <= Math.min(5, actualMaxTickets); i++) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`ticket_${lottery.id}_${i}`)
                    .setLabel(`${i} ticket${i > 1 ? "s" : ""} (${i * lottery.ticketPrice} skulls)`)
                    .setStyle(ButtonStyle.Primary),
            );
        }

        if (actualMaxTickets > 5) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`ticket_${lottery.id}_${actualMaxTickets}`)
                    .setLabel(`${actualMaxTickets} tickets (${actualMaxTickets * lottery.ticketPrice} skulls)`)
                    .setStyle(ButtonStyle.Primary),
            );
        }

        const row = new ActionRowBuilder().addComponents(buttons);

        await interaction.reply({
            content: `How many tickets would you like to purchase? (${lottery.ticketPrice} skulls per ticket)`,
            components: [row],
            ephemeral: true,
        });
        return;
    }

    const success = lotteryManager.addParticipant(lotteryId, interaction.user.id);
    if (success) {
        await interaction.reply({
            content: "You have joined the lottery!",
            ephemeral: true,
        });
        await notificationManager.sendJoinConfirmation(interaction.user, lottery);
    } else {
        await interaction.reply({
            content: "You are already participating in this lottery!",
            ephemeral: true,
        });
    }
}

async function handleTicketSelection(interaction, lotteryId, quantity) {
    const lottery = lotteryManager.getLottery(lotteryId);
    if (!lottery || lottery.status !== "active") {
        await interaction.reply({
            content: "This lottery is not active!",
            ephemeral: true,
        });
        return;
    }

    const totalCost = quantity * lottery.ticketPrice;
    if (!await skullManager.hasEnoughSkulls(interaction.user.id, totalCost)) {
        await interaction.reply({
            content: `You don't have enough skulls to purchase ${quantity} tickets. Required: ${totalCost} skulls.`,
            ephemeral: true,
        });
        return;
    }

    const success = await skullManager.removeSkulls(interaction.user.id, totalCost);
    if (success) {
        const joined = lotteryManager.addParticipant(lotteryId, interaction.user.id, quantity);
        if (joined) {
            await interaction.reply({
                content: `Successfully purchased ${quantity} ticket${quantity > 1 ? "s" : ""} for ${totalCost} skulls!`,
                ephemeral: true,
            });
            await notificationManager.sendJoinConfirmation(interaction.user, lottery);
        } else {
            await skullManager.addSkulls(interaction.user.id, totalCost);
            await interaction.reply({
                content: "You are already participating in this lottery!",
                ephemeral: true,
            });
        }
    } else {
        await interaction.reply({
            content: "Failed to process ticket purchase. Please try again.",
            ephemeral: true,
        });
    }
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

module.exports = {
    handleButton,
    createActionRow
};