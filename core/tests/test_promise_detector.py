"""The promise detector must not fire on real answers.

The risk of a text heuristic is the opposite of the bug it fixes: a finished
answer that happens to contain "let me" or "checking" would keep the turn
running, and the user would wait for a turn that had already said everything it
had to say. These are the shapes that must not be mistaken for a promise.
"""

from __future__ import annotations

import unittest

from lexiqode.agent.loop import looks_like_promise


class PromiseDetectorTest(unittest.TestCase):
    def test_bare_announcements_are_promises(self) -> None:
        for text in (
            "Работаю.",
            "Работаю",
            "работаю над этим",
            "Приступаю.",
            "Сейчас посмотрю.",
            "Сейчас проверю файл.",
            "Продолжаю работу.",
            "Working on it.",
            "Let me check the file.",
            "I'll look into it.",
            "Checking.",
            "On it.",
        ):
            self.assertTrue(looks_like_promise(text), f"{text!r} is a promise")

    def test_real_answers_are_not_promises(self) -> None:
        for text in (
            "В файле две строки: line one и line two.",
            "Готово: тесты проходят, 212 passed.",
            "Файл core/lexiqode/agent/loop.py содержит детектор повторов.",
            "Проверил: ошибка в строке 244, ход завершался на любом тексте.",
            "Не могу выполнить: файл вне рабочей папки.",
            "",
            "   ",
        ):
            self.assertFalse(looks_like_promise(text), f"{text!r} is an answer")

    def test_a_long_answer_that_mentions_working_is_not_a_promise(self) -> None:
        """The phrase inside a real answer must not keep the turn running."""

        text = (
            "Я работаю над этим уже несколько шагов и вот что нашёл: детектор "
            "повторов считал одинаковые вызовы, даже когда между ними была "
            "работа, и обрывал ход у работающего агента. Исправление — считать "
            "только подряд идущие вызовы. Тесты проходят."
        )
        self.assertFalse(looks_like_promise(text), "a long answer is an answer")

    def test_a_promise_with_a_little_more_words_is_still_a_promise(self) -> None:
        self.assertTrue(looks_like_promise("Работаю над этим, сейчас посмотрю файл."))
        self.assertTrue(looks_like_promise("Let me check the file and report back."))

    def test_a_very_long_message_starting_with_a_phrase_is_an_answer(self) -> None:
        """Past a point, a message that starts with a phrase is doing real work."""

        text = "Проверяю: " + ("детали " * 40)
        self.assertFalse(looks_like_promise(text), "a long message is not a bare promise")


if __name__ == "__main__":
    unittest.main()
