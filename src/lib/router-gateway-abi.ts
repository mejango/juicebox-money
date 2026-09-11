// Generated from an executed JBRouterTerminalGateway artifact by scripts/generate-protocol-rollout.mjs.
export const routerGatewayAbi = [
  {
    "type": "function",
    "name": "ROUTER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IJBRouterTerminal"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalizePendingCall",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "memo",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "metadata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "wasRefunded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "beneficiaryTokenCount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "finalizePendingCallWithGas",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "gasLimit",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "memo",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "metadata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "wasRefunded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "beneficiaryTokenCount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "pendingCallCommitmentOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "commitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingCallCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingCallFailureOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "failure",
        "type": "tuple",
        "internalType": "struct JBPendingRouterTerminalCallFailure",
        "components": [
          {
            "name": "errorHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "count",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "lastFailureAt",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "highestGasLimit",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "processPendingCall",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "memo",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "metadata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "beneficiaryTokenCount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "processPendingCallWithGas",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "gasLimit",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "memo",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "metadata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "beneficiaryTokenCount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "JBRouterTerminalGateway_ProcessPendingCall",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "beneficiaryTokenCount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "caller",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "JBRouterTerminalGateway_QueuePendingCall",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "memo",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "metadata",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "errorHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "caller",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "JBRouterTerminalGateway_RecordTerminalCallFailure",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "errorHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "count",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "nextAttemptAt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "caller",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "JBRouterTerminalGateway_RefundPendingCall",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "call",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct JBPendingRouterTerminalCall",
        "components": [
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "preferAddToBalance",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "shouldReturnHeldFees",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "beneficiary",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceProjectId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "caller",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  }
] as const
