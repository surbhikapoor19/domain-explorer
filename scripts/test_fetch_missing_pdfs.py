"""Unit tests for the PURE logic of fetch_missing_pdfs.

Covers title parsing from citation strings, first-author surname extraction,
title-similarity accept/reject, author matching, and slug computation. No
network is touched (the resolver/download functions are never invoked).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch_missing_pdfs as f  # noqa: E402


# Real citation strings taken from datasets/grasp-planning/grasp_planning.csv.
CIT_STRAIGHT = (
    'Shao, Lin, Fabio Ferreira, Mikael Jorda, Varun Nambiar, Jianlan Luo, '
    'Eugen Solowjow, Juan Aparicio Ojea, Oussama Khatib, and Jeannette Bohg. '
    '"Unigrasp: Learning a unified model to grasp with multifingered robotic '
    'hands." IEEE Robotics and Automation Letters 5, no. 2 (2020): 2286-2293.'
)
CIT_CURLY = (
    'P. Ni, W. Zhang, X. Zhu, and Q. Cao, “PointNet++ Grasping: Learning '
    'An End-to-end Spatial Grasp Generation Algorithm from Sparse Point '
    'Clouds,” Mar. 21, 2020, arXiv: arXiv:2003.09644. '
    'doi: 10.48550/arXiv.2003.09644.'
)
CIT_NO_QUOTE = 'Ni, P., Zhang, W. A grasp generation algorithm. 2020.'


class TitleParsing(unittest.TestCase):
    def test_straight_quotes(self):
        self.assertEqual(
            f.parse_title(CIT_STRAIGHT),
            'Unigrasp: Learning a unified model to grasp with '
            'multifingered robotic hands',
        )

    def test_curly_quotes_strip_trailing_comma(self):
        self.assertEqual(
            f.parse_title(CIT_CURLY),
            'PointNet++ Grasping: Learning An End-to-end Spatial Grasp '
            'Generation Algorithm from Sparse Point Clouds',
        )

    def test_no_quoted_span_returns_none(self):
        self.assertIsNone(f.parse_title(CIT_NO_QUOTE))

    def test_empty_returns_none(self):
        self.assertIsNone(f.parse_title(''))
        self.assertIsNone(f.parse_title(None))


class FirstAuthorSurname(unittest.TestCase):
    def test_surname_first_style(self):
        self.assertEqual(f.first_author_surname(CIT_STRAIGHT), 'Shao')

    def test_initials_first_style(self):
        self.assertEqual(f.first_author_surname(CIT_CURLY), 'Ni')

    def test_song(self):
        self.assertEqual(
            f.first_author_surname('Song, Pinhao, Yutong Hu. "X." 2025.'),
            'Song',
        )

    def test_empty(self):
        self.assertIsNone(f.first_author_surname(''))


class TitleSimilarity(unittest.TestCase):
    def test_identical_accepts(self):
        self.assertGreaterEqual(f.token_set_ratio('A B C', 'A B C'), 0.99)

    def test_casing_and_order_and_subtitle(self):
        a = 'Unigrasp: Learning a unified model to grasp with multifingered robotic hands'
        b = 'UniGrasp: Learning a Unified Model to Grasp with Multifingered Robotic Hands'
        self.assertGreaterEqual(f.token_set_ratio(a, b), 0.85)

    def test_unrelated_rejects(self):
        a = 'Contact-GraspNet: Efficient 6-DoF Grasp Generation in Cluttered Scenes'
        b = 'Deep Reinforcement Learning for Bipedal Locomotion'
        self.assertLess(f.token_set_ratio(a, b), 0.85)

    def test_empty_is_zero(self):
        self.assertEqual(f.token_set_ratio('', 'anything'), 0.0)


class AuthorMatch(unittest.TestCase):
    def test_surname_present_as_token(self):
        self.assertTrue(f.author_match('Shao', ['Lin Shao', 'Jeannette Bohg']))

    def test_surname_absent(self):
        self.assertFalse(f.author_match('Shao', ['Alice Smith', 'Bob Jones']))

    def test_substring_is_not_a_match(self):
        # "Ni" must match a whole token, not appear inside "Antonio".
        self.assertFalse(f.author_match('Ni', ['Antonio Rossi']))
        self.assertTrue(f.author_match('Ni', ['Peng Ni', 'Wenhao Zhang']))

    def test_vacuous_when_missing_info(self):
        self.assertTrue(f.author_match('Shao', []))
        self.assertTrue(f.author_match(None, ['Lin Shao']))


class VerifyMatch(unittest.TestCase):
    def test_accept_title_and_author(self):
        ok, score = f.verify_match(
            'UniGrasp: Learning a Unified Model to Grasp with Multifingered Robotic Hands',
            ['Lin Shao', 'Jeannette Bohg'],
            'Unigrasp: Learning a unified model to grasp with multifingered robotic hands',
            'Shao',
        )
        self.assertTrue(ok)
        self.assertGreaterEqual(score, 0.85)

    def test_reject_on_low_title_similarity(self):
        ok, score = f.verify_match(
            'A completely different paper about locomotion',
            ['Lin Shao'],
            'Unigrasp: Learning a unified model to grasp',
            'Shao',
        )
        self.assertFalse(ok)

    def test_reject_on_author_mismatch(self):
        # Title matches but the first-author surname is nowhere in the authors.
        ok, score = f.verify_match(
            'UniGrasp: Learning a Unified Model to Grasp with Multifingered Robotic Hands',
            ['Alice Smith', 'Bob Jones'],
            'Unigrasp: Learning a unified model to grasp with multifingered robotic hands',
            'Shao',
        )
        self.assertFalse(ok)
        self.assertGreaterEqual(score, 0.85)  # title was fine; author gate failed

    def test_reject_when_no_title(self):
        ok, score = f.verify_match('Some title', ['X'], None, 'Shao')
        self.assertFalse(ok)


class Slugify(unittest.TestCase):
    def test_emoji_and_hyphen(self):
        self.assertEqual(f.slugify('🤖 Contact-GraspNet'), 'contact-graspnet')

    def test_parenthetical_acronym(self):
        self.assertEqual(
            f.slugify('Grasp Pose Detection (GPD)'),
            'grasp-pose-detection-gpd',
        )

    def test_plusplus_collapses(self):
        self.assertEqual(f.slugify('PointNet++ Grasping'), 'pointnet-grasping')

    def test_unigrasp(self):
        self.assertEqual(f.slugify('UniGrasp'), 'unigrasp')

    def test_matches_backend_slugify_if_importable(self):
        # Guard against drift from backend/rag/method_paper_map.py when its
        # deps (pandas) are available; skip cleanly otherwise.
        try:
            repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            sys.path.insert(0, repo)
            from backend.rag.method_paper_map import _slugify  # type: ignore
        except Exception:
            self.skipTest('backend.rag.method_paper_map not importable')
        for name in ['🤖 Contact-GraspNet', 'Grasp Pose Detection (GPD)',
                     'PointNet++ Grasping', 'UniGrasp',
                     'Single-Shot SE(3) Grasp Detection (S4G)']:
            self.assertEqual(f.slugify(name), _slugify(name), name)


if __name__ == '__main__':
    unittest.main()
