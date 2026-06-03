from django.urls import path

from .live_assistant import AssistantLiveConsumer

websocket_urlpatterns = [
    path("ws/assistant/live/", AssistantLiveConsumer.as_asgi()),
]
