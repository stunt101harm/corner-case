/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/corner_case.json`.
 */
export type CornerCase = {
  "address": "J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN",
  "metadata": {
    "name": "cornerCase",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Corner Case — trustless P2P prop bets settled by TxLINE Merkle proofs"
  },
  "instructions": [
    {
      "name": "acceptMarket",
      "docs": [
        "Take the other side 1:1. Check gate #1: no accepts at/after kickoff."
      ],
      "discriminator": [
        175,
        75,
        176,
        53,
        90,
        68,
        91,
        143
      ],
      "accounts": [
        {
          "name": "taker",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "Re-derived from the *stored* creator + nonce, so a forged account at",
            "the right discriminator can't stand in for a real market."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.creator",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.nonce",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "mint",
          "address": "Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy"
        },
        {
          "name": "takerAta",
          "docs": [
            "Taker's canonical ATA — derived from (taker, pinned mint)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "taker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrow",
          "docs": [
            "The market's escrow ATA, re-derived — funds can only land in the one",
            "escrow this market owns."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "cancelMarket",
      "docs": [
        "Creator-only: reclaim an unmatched market (stake + all rent)."
      ],
      "discriminator": [
        205,
        121,
        84,
        210,
        222,
        71,
        150,
        11
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "Must be the stored creator (has_one below) — nobody else can pull an",
            "open market out from under would-be takers, or steal the refund."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.creator",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.nonce",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "mint",
          "address": "Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy"
        },
        {
          "name": "creatorAta",
          "docs": [
            "Refund destination: the creator's canonical ATA, derived — not a",
            "caller-supplied account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "docs": [
        "Open a market: init the Market PDA (space sized to the strategy),",
        "init the PDA-owned escrow ATA, move the creator's stake in."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "Space is allocated from the actual strategy arg, so a 16-byte",
            "\"corners > 9\" market doesn't pay rent for 512 bytes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Pinned settlement mint. `address =` makes \"wrong token\" a constraint",
            "violation, not a runtime branch someone can forget."
          ],
          "address": "Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy"
        },
        {
          "name": "creatorAta",
          "docs": [
            "Creator's canonical USDC-dev ATA — derived, never free-form."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrow",
          "docs": [
            "Escrow = the market PDA's own ATA for the pinned mint. Nobody holds a",
            "key for it; only this program can sign it via the market seeds."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "fixtureId",
          "type": "i64"
        },
        {
          "name": "epochDay",
          "type": "u16"
        },
        {
          "name": "kickoffTs",
          "type": "i64"
        },
        {
          "name": "creatorSide",
          "type": "bool"
        },
        {
          "name": "stake",
          "type": "u64"
        },
        {
          "name": "strategy",
          "type": "bytes"
        },
        {
          "name": "statKeys",
          "type": {
            "vec": "u32"
          }
        }
      ]
    },
    {
      "name": "settleMarket",
      "docs": [
        "Permissionless settlement: CPI into TxLINE's `validateStatV2` with",
        "the STORED strategy against the caller-selected daily root, read the",
        "verdict from return data, pay the winning side. Five check gates —",
        "see instructions/settle_market.rs for the full story."
      ],
      "discriminator": [
        193,
        153,
        95,
        216,
        166,
        6,
        144,
        217
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller (the keeper in practice, but anyone may settle)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.creator",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.nonce",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "creator",
          "docs": [
            "Rent destination on close; must be the stored creator."
          ],
          "writable": true
        },
        {
          "name": "taker",
          "docs": [
            "taker's canonical ATA below."
          ]
        },
        {
          "name": "mint",
          "address": "Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy"
        },
        {
          "name": "creatorAta",
          "docs": [
            "Creator's canonical ATA — one of exactly two possible payout",
            "destinations. Both are derivation-constrained; the caller cannot",
            "substitute a free-form winner account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "takerAta",
          "docs": [
            "Taker's canonical ATA — the other possible payout destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "taker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "txlineRoots",
          "docs": [
            "TxLINE's daily scores Merkle root account for `epoch_day`.",
            "TXORACLE_ID (never our own program id — a classic foreign-PDA bug) and",
            "requires the account to be owned by TxLINE. The proof only verifies if",
            "it chains to whatever root TxLINE posted in this exact account, so a",
            "wrong-but-well-derived day simply fails validation."
          ]
        },
        {
          "name": "txlineProgram",
          "docs": [
            "CPI target is executable."
          ],
          "address": "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        }
      ],
      "args": [
        {
          "name": "epochDay",
          "type": "u16"
        },
        {
          "name": "payload",
          "type": {
            "defined": {
              "name": "statValidationInput"
            }
          }
        }
      ]
    },
    {
      "name": "voidMarket",
      "docs": [
        "Permissionless mutual refund once a matched market has sat unsettled",
        "for VOID_DELAY_SECS past kickoff."
      ],
      "discriminator": [
        243,
        175,
        46,
        124,
        95,
        101,
        39,
        69
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.creator",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.nonce",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "creator",
          "docs": [
            "escrow + market rent and (via ATA derivation below) the refund."
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "taker",
          "docs": [
            "has_one: an *unmatched* market stores `Pubkey::default()` here, and a",
            "constraint would mask the real \"market is not matched\" error). The",
            "binding is enforced before any transfer; only used as the ATA",
            "derivation authority below."
          ]
        },
        {
          "name": "mint",
          "address": "Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy"
        },
        {
          "name": "creatorAta",
          "docs": [
            "Refund destinations are both *derived* ATAs of the stored parties —",
            "the caller (who can be anyone) picks nothing."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "takerAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "taker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    }
  ],
  "events": [
    {
      "name": "marketSettled",
      "discriminator": [
        237,
        212,
        22,
        175,
        201,
        117,
        215,
        99
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroStake",
      "msg": "Stake must be greater than zero"
    },
    {
      "code": 6001,
      "name": "strategyLengthOutOfBounds",
      "msg": "Strategy must be between 8 and 512 bytes"
    },
    {
      "code": 6002,
      "name": "kickoffNotInFuture",
      "msg": "Kickoff must be in the future at market creation"
    },
    {
      "code": 6003,
      "name": "wrongMint",
      "msg": "Token account is not the pinned USDC-dev mint"
    },
    {
      "code": 6004,
      "name": "marketNotOpen",
      "msg": "Market is not open"
    },
    {
      "code": 6005,
      "name": "marketNotMatched",
      "msg": "Market is not matched"
    },
    {
      "code": 6006,
      "name": "kickoffPassed",
      "msg": "Kickoff has passed; accepts are closed"
    },
    {
      "code": 6007,
      "name": "selfMatch",
      "msg": "Creator cannot take their own market"
    },
    {
      "code": 6008,
      "name": "unauthorized",
      "msg": "Only the market creator may do this"
    },
    {
      "code": 6009,
      "name": "takerMismatch",
      "msg": "Taker account does not match the stored taker"
    },
    {
      "code": 6010,
      "name": "voidDelayNotElapsed",
      "msg": "Void delay has not elapsed yet"
    },
    {
      "code": 6011,
      "name": "escrowUnderfunded",
      "msg": "Escrow balance below expected stake (invariant violation)"
    },
    {
      "code": 6012,
      "name": "statKeysCountOutOfBounds",
      "msg": "Market must pin 1-5 stat keys (TxLINE's per-proof limit)"
    },
    {
      "code": 6013,
      "name": "epochDayOutOfRange",
      "msg": "epoch_day must be the market's stored day or the day after"
    },
    {
      "code": 6014,
      "name": "fixtureMismatch",
      "msg": "Proof is for a different fixture than this market"
    },
    {
      "code": 6015,
      "name": "statKeysMismatch",
      "msg": "Proof leaves do not match the market's pinned stat keys"
    },
    {
      "code": 6016,
      "name": "proofNotFinal",
      "msg": "Proof is from a mid-match record; settlement requires game_finalised (period 100)"
    },
    {
      "code": 6017,
      "name": "invalidRootsAccount",
      "msg": "TxLINE roots account or program does not match the expected derivation"
    },
    {
      "code": 6018,
      "name": "noValidationResult",
      "msg": "TxLINE validation returned no readable verdict"
    }
  ],
  "types": [
    {
      "name": "market",
      "docs": [
        "One P2P market. PDA: `[\"market\", creator, nonce u64 LE]` — the nonce keeps",
        "one creator free to open several markets on the same fixture (the demo",
        "creates two).",
        "",
        "`strategy` is the byte-exact TxLINE `validateStatV2` strategy encoding,",
        "captured at creation: \"what you sign is what settles\". The program never",
        "interprets it; settle_market splices it verbatim into the validation call."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "docs": [
              "Market creator; funded the first stake, receives rent on close."
            ],
            "type": "pubkey"
          },
          {
            "name": "taker",
            "docs": [
              "Matched taker; `Pubkey::default()` until accept_market."
            ],
            "type": "pubkey"
          },
          {
            "name": "fixtureId",
            "docs": [
              "TxLINE fixture id (i64, TxLINE's native type). Settlement must bind",
              "proofs to this exact fixture — see settle_market stub notes."
            ],
            "type": "i64"
          },
          {
            "name": "epochDay",
            "docs": [
              "Creation-time estimate of the TxLINE `daily_scores_roots` epoch day",
              "(floor(ts_ms / 86_400_000)). settle_market will accept {stored,",
              "stored+1} because evening kickoffs finalise after 00:00 UTC."
            ],
            "type": "u16"
          },
          {
            "name": "kickoffTs",
            "docs": [
              "Scheduled kickoff (unix). Check gate #1 (accepts) and the void escape",
              "hatch both key off this."
            ],
            "type": "i64"
          },
          {
            "name": "stake",
            "docs": [
              "Per-side stake in USDC-dev base units. Escrow holds 2x once matched."
            ],
            "type": "u64"
          },
          {
            "name": "creatorSide",
            "docs": [
              "true = creator bets the strategy predicate evaluates TRUE."
            ],
            "type": "bool"
          },
          {
            "name": "state",
            "docs": [
              "Lifecycle state; every instruction checks it first."
            ],
            "type": {
              "defined": {
                "name": "marketState"
              }
            }
          },
          {
            "name": "nonce",
            "docs": [
              "PDA seed component; creator-chosen, collision-free per creator."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump, stored once at init so every later signer derivation is O(1)",
              "and canonical."
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Creation unix time (Clock), for UI/keeper bookkeeping."
            ],
            "type": "i64"
          },
          {
            "name": "strategy",
            "docs": [
              "Opaque TxLINE strategy bytes (see struct docs). Variable length —",
              "account space is allocated from the instruction arg at init."
            ],
            "type": "bytes"
          },
          {
            "name": "statKeys",
            "docs": [
              "Check gate #5: the ordered TxLINE stat keys the strategy's leaf",
              "indices refer to (index i in the strategy == key stat_keys[i]).",
              "Settlement refuses a proof whose leaves don't match this list exactly",
              "— without it, a valid proof of the WRONG stats (goals instead of",
              "corners) could flip the payout. 1–5 keys (TxLINE's per-proof limit)."
            ],
            "type": {
              "vec": "u32"
            }
          }
        ]
      }
    },
    {
      "name": "marketSettled",
      "docs": [
        "Emitted on settlement so the frontend receipt can reconstruct the outcome",
        "without re-reading the (now closed) market account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "predicateTrue",
            "type": "bool"
          },
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "epochDay",
            "type": "u16"
          },
          {
            "name": "proofTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketState",
      "docs": [
        "Lifecycle of a market. Terminal states (Settled/Cancelled/Voided) are set",
        "just before the Market account is closed in the same instruction — they",
        "exist so the state machine is explicit and so a double-spend race resolves",
        "as a clean state error, never as a second payout."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "matched"
          },
          {
            "name": "settled"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "voided"
          }
        ]
      }
    },
    {
      "name": "proofNode",
      "docs": [
        "One sibling hash in a Merkle path."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "isRightSibling",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "scoreStat",
      "docs": [
        "A single provable key/value statistic — the innermost Merkle leaf.",
        "`period` is the match-status period of the underlying score record",
        "(3 = halftime, 100 = game finalised), NOT the stat key's period prefix."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "u32"
          },
          {
            "name": "value",
            "type": "i32"
          },
          {
            "name": "period",
            "type": "i32"
          }
        ]
      }
    },
    {
      "name": "scoresBatchSummary",
      "docs": [
        "Fixture-level summary — the node that binds a proof to ONE fixture.",
        "`fixture_id` living inside the proven chain is what makes on-chain fixture",
        "binding possible (settle_market's FixtureMismatch gate)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "updateStats",
            "type": {
              "defined": {
                "name": "scoresUpdateStats"
              }
            }
          },
          {
            "name": "eventsSubTreeRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "scoresUpdateStats",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updateCount",
            "type": "i32"
          },
          {
            "name": "minTimestamp",
            "type": "i64"
          },
          {
            "name": "maxTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "statLeaf",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stat",
            "type": {
              "defined": {
                "name": "scoreStat"
              }
            }
          },
          {
            "name": "statProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "statValidationInput",
      "docs": [
        "Full `validate_stat_v2` payload (IDL: `StatValidationInput`), exactly as",
        "the stat-validation endpoint hands it to the keeper."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "fixtureSummary",
            "type": {
              "defined": {
                "name": "scoresBatchSummary"
              }
            }
          },
          {
            "name": "fixtureProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          },
          {
            "name": "mainTreeProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          },
          {
            "name": "eventStatRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stats",
            "type": {
              "vec": {
                "defined": {
                  "name": "statLeaf"
                }
              }
            }
          }
        ]
      }
    }
  ]
};
