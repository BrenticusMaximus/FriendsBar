import decky_plugin


class Plugin:
    async def _main(self) -> None:
        decky_plugin.logger.info("FriendsBar backend initialized")

    async def _unload(self) -> None:
        decky_plugin.logger.info("FriendsBar backend unloaded")
