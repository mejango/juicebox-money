// SPDX-License-Identifier: MIT
// Unaudited example code for learning. Review, test, and audit before using it with real funds.
//
// Build with Foundry:
//   npm install @bananapus/core-v6
//   printf '[profile.default]\nsolc = "0.8.28"\nevm_version = "cancun"\nlibs = ["node_modules"]\n' > foundry.toml
//   mkdir -p src && mv MyPayHook.sol src/ && forge build
pragma solidity 0.8.28;

import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBPayHook} from "@bananapus/core-v6/src/interfaces/IJBPayHook.sol";
import {IJBRulesetDataHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetDataHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBAfterPayRecordedContext} from "@bananapus/core-v6/src/structs/JBAfterPayRecordedContext.sol";
import {JBBeforeCashOutRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforeCashOutRecordedContext.sol";
import {JBBeforePayRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforePayRecordedContext.sol";
import {JBCashOutHookSpecification} from "@bananapus/core-v6/src/structs/JBCashOutHookSpecification.sol";
import {JBPayHookSpecification} from "@bananapus/core-v6/src/structs/JBPayHookSpecification.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {ERC165, IERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/// @notice A data hook and a pay hook in one contract. It leaves issuance and cash outs unchanged and counts each
/// payer's payments to one project.
/// @dev To install it, set the ruleset's `metadata.dataHook` to this contract and `useDataHookForPay` to true.
contract MyPayHook is ERC165, IJBRulesetDataHook, IJBPayHook {
    error MyPayHook_Unauthorized(address caller, uint256 projectId);

    /// @notice The directory that lists each project's terminals.
    IJBDirectory public immutable DIRECTORY;

    /// @notice The only project this hook serves.
    uint256 public immutable PROJECT_ID;

    /// @notice The number of payments recorded from each payer.
    mapping(address payer => uint256) public paymentCountOf;

    constructor(IJBDirectory directory, uint256 projectId) {
        DIRECTORY = directory;
        PROJECT_ID = projectId;
    }

    /// @notice Data hook: runs before a payment is recorded. Returns the weight to issue tokens with and the pay
    /// hooks to call afterwards.
    /// @dev A view called by the terminal's store. It changes no state, so it needs no caller check.
    function beforePayRecordedWith(JBBeforePayRecordedContext calldata context)
        external
        view
        override
        returns (uint256 weight, JBPayHookSpecification[] memory hookSpecifications)
    {
        // Keep the ruleset's issuance. Return a different weight to change how many tokens the payment creates.
        weight = context.weight;

        // Ask the terminal to call `afterPayRecordedWith` on this contract, forwarding none of the payment.
        hookSpecifications = new JBPayHookSpecification[](1);
        hookSpecifications[0] =
            JBPayHookSpecification({hook: IJBPayHook(address(this)), noop: false, amount: 0, metadata: ""});
    }

    /// @notice Pay hook: runs after the payment is recorded and its tokens are created.
    /// @dev Anyone can call this function with any context, so authenticate the caller before trusting it.
    function afterPayRecordedWith(JBAfterPayRecordedContext calldata context) external payable override {
        // Only a terminal of this hook's project may call.
        if (context.projectId != PROJECT_ID || !DIRECTORY.isTerminalOf(PROJECT_ID, IJBTerminal(msg.sender))) {
            revert MyPayHook_Unauthorized(msg.sender, context.projectId);
        }

        paymentCountOf[context.payer]++;
    }

    /// @notice Data hook: runs before a cash out is recorded. Only called when the ruleset sets
    /// `useDataHookForCashOut`. Returns every input unchanged and no cash out hooks.
    function beforeCashOutRecordedWith(JBBeforeCashOutRecordedContext calldata context)
        external
        pure
        override
        returns (
            uint256 cashOutTaxRate,
            uint256 effectiveCashOutCount,
            uint256 effectiveTotalSupply,
            uint256 effectiveSurplusValue,
            JBCashOutHookSpecification[] memory hookSpecifications
        )
    {
        return (
            context.cashOutTaxRate, context.cashOutCount, context.totalSupply, context.surplus.value, hookSpecifications
        );
    }

    /// @notice Data hook: whether an address may mint this project's tokens without the owner's permission.
    function hasMintPermissionFor(uint256, JBRuleset calldata, address) external pure override returns (bool) {
        return false;
    }

    /// @notice ERC-165: declares the two hook interfaces this contract implements.
    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IJBRulesetDataHook).interfaceId || interfaceId == type(IJBPayHook).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
