from django.test import SimpleTestCase

from .av24_catalog import normalized_sku, parse_product_page, referenced_hardware_ids, resolve_source_item


class Av24CatalogTests(SimpleTestCase):
    def test_product_page_extracts_features_and_drawing(self):
        markup = '''
        <h1>Петля Альфа FDP-10</h1>
        <span class="js-product-sku">FDP-10 SUS304/BL</span>
        <div class="product-features__name">Толщина стекла</div>
        <div class="product-features__value">8 мм, 10 мм</div>
        <h3>Чертеж</h3><a href="http://av24.su/wa-data/public/site/drawings/FDP-10.pdf">Загрузить чертеж (PDF)</a>
        <figure><img src="/wa-data/public/site/drawings/FDP-10.jpg"></figure>
        '''
        data = parse_product_page("https://av24.su/petlya-fdp-10/", markup, checked_at="2026-10-14T00:00:00+00:00")
        self.assertEqual(data["sku"], "FDP-10 SUS304/BL")
        self.assertEqual(data["features"]["Толщина стекла"], "8 мм, 10 мм")
        self.assertEqual(data["drawingUrl"], "https://av24.su/wa-data/public/site/drawings/FDP-10.pdf")
        self.assertEqual(data["review"]["status"], "pending")

    def test_referenced_ids_are_unique(self):
        catalog = {"constructions": [
            {"hardwareComponents": [{"hardwareItemId": "one"}, {"hardwareItemId": "two"}]},
            {"hardwareComponents": [{"hardwareItemId": "one"}]},
        ]}
        self.assertEqual(referenced_hardware_ids(catalog), ["one", "two"])

    def test_custom_item_can_reuse_exact_sku_source(self):
        custom = {"id": "custom", "label": "AV24 FDC-32: соединитель"}
        source = {"id": "av24-1", "sku": "FDC-32 SUS304/PSS", "sourceUrl": "https://av24.su/fdc-32/"}
        self.assertEqual(resolve_source_item(custom, [custom, source]), source)
        self.assertEqual(normalized_sku("AV24 FDK-5L: стабилизатор"), "FDK-5L")
