"""
Typed boundary around pytubefix, which ships without type information.

The Protocols describe only the parts of pytubefix these tools use, so the
tools themselves stay fully typed. Import YouTube things from here, never from
pytubefix directly. Tools that use this must still list pytubefix in their own
PEP 723 dependencies.
"""

from collections.abc import Callable, Iterable
from typing import Protocol, cast

# pytubefix has no stubs or py.typed marker; everything it returns is narrowed
# through the Protocols below.
import pytubefix  # pyright: ignore[reportMissingTypeStubs]
from pytubefix.exceptions import PytubeFixError  # pyright: ignore[reportMissingTypeStubs]

__all__ = ["Caption", "PytubeFixError", "Stream", "StreamQuery", "Video", "open_video"]


class Stream(Protocol):
    @property
    def filesize(self) -> int: ...
    @property
    def filesize_mb(self) -> float: ...
    @property
    def default_filename(self) -> str: ...
    @property
    def resolution(self) -> str | None: ...
    @property
    def fps(self) -> int | None: ...
    @property
    def abr(self) -> str | None: ...

    def download(
        self, output_path: str | None = None, filename: str | None = None
    ) -> str | None: ...


class StreamQuery(Protocol):
    def filter(
        self,
        *,
        mime_type: str | None = None,
        only_audio: bool | None = None,
        only_video: bool | None = None,
        adaptive: bool | None = None,
    ) -> "StreamQuery": ...
    def order_by(self, attribute_name: str) -> "StreamQuery": ...
    def desc(self) -> "StreamQuery": ...
    def first(self) -> Stream | None: ...


class Caption(Protocol):
    @property
    def code(self) -> str: ...
    @property
    def name(self) -> str: ...

    def generate_txt_captions(self) -> str: ...


class Video(Protocol):
    @property
    def title(self) -> str: ...
    @property
    def author(self) -> str: ...
    @property
    def video_id(self) -> str: ...
    @property
    def streams(self) -> StreamQuery: ...
    @property
    def captions(self) -> Iterable[Caption]: ...

    def register_on_progress_callback(self, func: Callable[[Stream, bytes, int], None]) -> None: ...


def open_video(url: str) -> Video:
    """Look up a YouTube video (network call)."""
    return cast(Video, pytubefix.YouTube(url))
