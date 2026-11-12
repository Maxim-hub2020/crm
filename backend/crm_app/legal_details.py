LEGAL_FIELDS = {
    "name": ("Наименование организации", 250),
    "inn": ("ИНН", 10),
    "kpp": ("КПП", 9),
    "ogrn": ("ОГРН", 13),
    "address": ("Юридический адрес", 350),
    "signatory": ("ФИО подписанта", 150),
    "position": ("Должность подписанта", 100),
    "bank": ("Банк", 150),
    "bik": ("БИК", 9),
    "account": ("Расчётный счёт", 20),
    "correspondent_account": ("Корреспондентский счёт", 20),
}
REQUIRED_LEGAL_FIELDS = ("name", "inn", "address")
NUMERIC_LEGAL_FIELDS = {"inn", "kpp", "ogrn", "bik", "account", "correspondent_account"}
