class MultiPlatformRunError(Exception):
    def __init__(self, failed_platforms: list):
        self.failed_platforms = failed_platforms
        super().__init__(f"Platforms failed: {', '.join(failed_platforms)}")
