import time

import requests
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from crm_app.av24_catalog import (
    fetch_product_page,
    referenced_hardware_ids,
    resolve_source_item,
)
from crm_app.models import CalculatorSettings, default_workspace


class Command(BaseCommand):
    help = "Link AV24 product cards and technical drawings to the CEH CRM shower catalog."

    def add_arguments(self, parser):
        parser.add_argument("--all", action="store_true", help="Process the whole hardware catalog instead of referenced items.")
        parser.add_argument("--limit", type=int, default=0)
        parser.add_argument("--delay", type=float, default=0.4)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        settings_record = CalculatorSettings.objects.filter(workspace=default_workspace()).first()
        if not settings_record or not isinstance(settings_record.shower_catalog, dict):
            raise CommandError("Каталог душевых не найден.")
        catalog = settings_record.shower_catalog
        items = catalog.get("hardwareItems", [])
        item_map = {str(item.get("id")): item for item in items if item.get("id")}
        selected_ids = list(item_map) if options["all"] else referenced_hardware_ids(catalog)
        if options["limit"] > 0:
            selected_ids = selected_ids[:options["limit"]]

        linked = missing = failed = relinked = 0
        session = requests.Session()
        for index, item_id in enumerate(selected_ids, start=1):
            item = item_map.get(item_id)
            if not item:
                failed += 1
                self.stderr.write(f"[{index}/{len(selected_ids)}] В каталоге отсутствует {item_id}")
                continue
            source_item = resolve_source_item(item, items)
            source_url = source_item.get("sourceUrl")
            if not source_url:
                missing += 1
                item["technicalData"] = {
                    "source": "AV24", "sourceStatus": "source_not_found",
                    "review": {"status": "blocked", "note": "Не найдена точная карточка артикула AV24."},
                }
                self.stdout.write(f"[{index}/{len(selected_ids)}] {item.get('label')}: карточка не найдена")
                continue
            if source_item is not item:
                item["sourceUrl"] = source_url
                item["sourceProductId"] = source_item.get("sourceProductId")
                if not item.get("sku"):
                    item["sku"] = source_item.get("sku")
                relinked += 1
            try:
                item["technicalData"] = fetch_product_page(source_url, session=session)
                if item["technicalData"].get("drawingUrl"):
                    linked += 1
                else:
                    missing += 1
                self.stdout.write(
                    f"[{index}/{len(selected_ids)}] {item.get('sku') or item_id}: "
                    f"{item['technicalData']['sourceStatus']}"
                )
            except (requests.RequestException, ValueError) as error:
                failed += 1
                item["technicalData"] = {
                    "source": "AV24", "sourcePage": source_url, "sourceStatus": "fetch_failed",
                    "review": {"status": "blocked", "note": str(error)[:300]},
                }
                self.stderr.write(f"[{index}/{len(selected_ids)}] {item_id}: {error}")
            if options["delay"] > 0 and index < len(selected_ids):
                time.sleep(options["delay"])

        if not options["dry_run"]:
            with transaction.atomic():
                locked = CalculatorSettings.objects.select_for_update().get(pk=settings_record.pk)
                locked.shower_catalog = catalog
                locked.save(update_fields=["shower_catalog", "updated_at"])
        suffix = " (dry-run)" if options["dry_run"] else ""
        self.stdout.write(self.style.SUCCESS(
            f"AV24: чертежей {linked}, без чертежа {missing}, ошибок {failed}, "
            f"восстановлено ссылок {relinked}{suffix}."
        ))
