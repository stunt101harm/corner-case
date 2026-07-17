// Anchor migration entrypoint (`anchor migrate`). Nothing to seed for this
// program — deployment alone is sufficient; markets are created by users.
import * as anchor from "@coral-xyz/anchor";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);
};
