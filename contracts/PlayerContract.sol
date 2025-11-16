// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title PlayerData - Manages player information
/// @notice Simple contract to store and manage player data, currently only kills
contract PlayerData {
    struct Player {
        uint256 kills;
        bool exists;
    }
    mapping(address => Player) private players;
    // Support for non-EVM identifiers using bytes32 keys

    mapping(bytes32 => Player) private playersById;
    address public owner;

    event KillsUpdated(address indexed player, uint256 kills);
    event KillsUpdatedById(bytes32 indexed playerId, uint256 kills);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    function setKills(uint256 _kills) external {
        players[msg.sender].kills = _kills;
        players[msg.sender].exists = true;
        emit KillsUpdated(msg.sender, _kills);
    }

    /// @param _player Wallet address of player
    /// @return number of kills
    function getKills(address _player) external view returns (uint256) {
        return players[_player].kills;
    }

    /// @notice Get kills for a player identified by a bytes32 id (keccak256 of identifier string)
    function getKillsById(bytes32 _playerId) external view returns (uint256) {
        return playersById[_playerId].kills;
    }

    function incrementKills(uint256 _by) external {
        players[msg.sender].kills += _by;
        players[msg.sender].exists = true;
        emit KillsUpdated(msg.sender, players[msg.sender].kills);
    }

    function adminSetKills(address _player, uint256 _kills) external onlyOwner {
        players[_player].kills = _kills;
        players[_player].exists = true;
        emit KillsUpdated(_player, _kills);
    }

    /// @notice Admin entrypoint to set kills for a non-EVM identifier (keccak256 id)
    function adminSetKillsById(bytes32 _playerId, uint256 _kills) external onlyOwner {
        playersById[_playerId].kills = _kills;
        playersById[_playerId].exists = true;
        emit KillsUpdatedById(_playerId, _kills);
    }
}
