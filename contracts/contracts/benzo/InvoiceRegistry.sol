// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

/// @title Commitment-only B2B invoice registry for Benzo workflows.
/// @notice Stores invoice commitments and payee attestations without storing invoice amounts.
/// @dev Commitment preimage is formed off-chain as
/// `keccak256(abi.encode(amount, token, payee, invoiceSalt))` and shared with
/// the payer off-chain. The commitment is opaque to this contract.
contract InvoiceRegistry {
    enum Status {
        Created,
        Paid,
        Cancelled
    }

    struct Invoice {
        address payee;
        address payer;
        bytes32 commitment;
        uint64 createdAt;
        uint64 expiry;
        Status status;
        bytes32 paymentRef;
    }

    error EmptyCommitment();
    error InvoiceNotFound(uint256 id);
    error InvoiceNotCreated(uint256 id, Status status);
    error OnlyPayee(uint256 id, address caller);

    event InvoiceCreated(
        uint256 indexed id,
        address indexed payee,
        address indexed payer,
        bytes32 commitment,
        uint64 expiry
    );
    event InvoiceCancelled(uint256 indexed id);
    event InvoicePaid(uint256 indexed id, bytes32 paymentRef);

    uint256 private _nextInvoiceId = 1;
    mapping(uint256 id => Invoice invoice) private _invoices;

    /// @notice Returns the number of invoices created so far.
    function invoiceCount() external view returns (uint256) {
        return _nextInvoiceId - 1;
    }

    /// @notice Returns the stored invoice record.
    /// @dev Reverts for unknown ids rather than returning the zero-value struct,
    /// whose status would otherwise look like `Created`.
    function getInvoice(uint256 id) external view returns (Invoice memory invoice) {
        _requireExists(id);
        return _invoices[id];
    }

    /// @notice Returns whether an invoice is expired at the current block timestamp.
    /// @dev Expiry is evaluated lazily. `expiry == 0` means no expiry.
    function isExpired(uint256 id) external view returns (bool) {
        _requireExists(id);

        uint64 expiry = _invoices[id].expiry;
        return expiry != 0 && block.timestamp >= expiry;
    }

    /// @notice Creates a commitment-only invoice request.
    /// @param commitment Opaque invoice commitment. The off-chain scheme is
    /// `keccak256(abi.encode(amount, token, payee, invoiceSalt))`.
    /// @param payer Payer address for a restricted invoice, or `address(0)` for
    /// an open invoice where anyone with the preimage may pay off-chain.
    /// @param expiry Expiry timestamp, or zero for no expiry.
    /// @return id Newly assigned invoice id.
    function createInvoice(
        bytes32 commitment,
        address payer,
        uint64 expiry
    ) external returns (uint256 id) {
        if (commitment == bytes32(0)) {
            revert EmptyCommitment();
        }

        id = _nextInvoiceId++;
        _invoices[id] = Invoice({
            payee: msg.sender,
            payer: payer,
            commitment: commitment,
            createdAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.Created,
            paymentRef: bytes32(0)
        });

        emit InvoiceCreated(id, msg.sender, payer, commitment, expiry);
    }

    /// @notice Cancels an invoice.
    /// @dev Payee-only and only while `Created`. Expired invoices remain
    /// cancelable because expiry is a lazy view, not a state transition.
    function cancelInvoice(uint256 id) external {
        _requireCreated(id);
        _requirePayee(id);

        _invoices[id].status = Status.Cancelled;

        emit InvoiceCancelled(id);
    }

    /// @notice Marks an invoice as paid by payee attestation.
    /// @dev Payee-only attestation. This function verifies nothing about value
    /// movement: it does not prove an eERC transfer occurred, does not verify an
    /// amount or token, and does not bind `paymentRef` to this invoice. The
    /// `paymentRef` is unverified bookkeeping, typically the eERC transfer
    /// transaction hash observed off-chain by the payee. Late acknowledgements
    /// are allowed after expiry, but a cancelled invoice can never be marked paid.
    function markPaid(uint256 id, bytes32 paymentRef) external {
        _requireCreated(id);
        _requirePayee(id);

        _invoices[id].status = Status.Paid;
        _invoices[id].paymentRef = paymentRef;

        emit InvoicePaid(id, paymentRef);
    }

    function _requireExists(uint256 id) private view {
        if (id == 0 || id >= _nextInvoiceId) {
            revert InvoiceNotFound(id);
        }
    }

    function _requireCreated(uint256 id) private view {
        _requireExists(id);

        Status status = _invoices[id].status;
        if (status != Status.Created) {
            revert InvoiceNotCreated(id, status);
        }
    }

    function _requirePayee(uint256 id) private view {
        if (msg.sender != _invoices[id].payee) {
            revert OnlyPayee(id, msg.sender);
        }
    }
}
