import logging

from django.utils import timezone

logger = logging.getLogger(__name__)

try:
    from celery import shared_task
except ImportError:  # pragma: no cover - local fallback before deps are installed
    shared_task = None


def _run_long_assistant_operation(user_id, operation, payload):
    started_at = timezone.now()
    logger.info(
        "Assistant long operation started: user_id=%s operation=%s payload=%s",
        user_id,
        operation,
        payload,
    )

    # Placeholder worker entrypoint. Heavy operations will be implemented here
    # without blocking the low-latency Live API session.
    result = {
        "ok": True,
        "operation": operation,
        "user_id": user_id,
        "started_at": started_at.isoformat(),
        "finished_at": timezone.now().isoformat(),
    }
    logger.info("Assistant long operation finished: %s", result)
    return result


if shared_task:
    run_long_assistant_operation = shared_task(
        name="crm_app.run_long_assistant_operation",
        queue="assistant",
        time_limit=900,
        soft_time_limit=840,
    )(_run_long_assistant_operation)
else:

    class _MissingCeleryTask:
        def delay(self, user_id, operation, payload):
            logger.warning(
                "Celery is not installed; assistant long operation was logged locally: user_id=%s operation=%s",
                user_id,
                operation,
            )
            _run_long_assistant_operation(user_id, operation, payload)
            return None

    run_long_assistant_operation = _MissingCeleryTask()


def enqueue_long_assistant_operation(user_id, operation, payload):
    result = run_long_assistant_operation.delay(user_id, operation, payload or {})
    return getattr(result, "id", "") or ""
