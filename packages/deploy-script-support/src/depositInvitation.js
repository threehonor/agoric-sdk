// @ts-check
import { E } from '@endo/far';

/**
 * @import {Amount, Brand, Issuer, Payment, Purse} from '@agoric/ertp';
 * @import {InvitationDetails} from '@agoric/zoe';
 */

/**
 * @param {ERef<Purse>} zoeInvitationPurse
 */
export const makeDepositInvitation = zoeInvitationPurse => {
  /**
   * @param {ERef<Invitation>} invitationP
   * @returns {Promise<InvitationDetails>}
   */
  const depositInvitation = async invitationP => {
    const invitation = await invitationP;
    // Deposit returns the amount deposited
    const invitationAmount = await E(zoeInvitationPurse).deposit(invitation);
    return invitationAmount.value[0];
  };
  return depositInvitation;
};
