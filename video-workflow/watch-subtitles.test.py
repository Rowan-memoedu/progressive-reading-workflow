import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('watch_subtitles',Path(__file__).with_name('watch-subtitles.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SubtitleMetadataTests(unittest.TestCase):
    def setUp(self):
        self.job={'bvid':'BV1234567890','part':2,'parts':3,'url':'https://www.bilibili.com/video/BV1234567890/?p=2'}
    def factory(self,info):
        case=self
        class Ydl:
            def __init__(self,options):
                case.assertTrue(options['writesubtitles']);case.assertTrue(options['writeautomaticsub'])
                case.assertTrue(options['skip_download']);case.assertTrue(options['noplaylist'])
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def extract_info(self,url,download):
                case.assertEqual(url,case.job['url']);case.assertFalse(download);return info
        return Ydl
    def test_metadata_requests_captions_without_downloading_media(self):
        info={'id':'BV1234567890_p2','subtitles':{'ai-zh':[{'ext':'srt'}]}}
        self.assertIs(module.exact_part_info(self.job,'unused',self.factory(info)),info)
    def test_danmaku_is_not_subtitles(self):
        with self.assertRaisesRegex(ValueError,'not_yet_available'):
            module.exact_part_info(self.job,'unused',self.factory({'id':'BV1234567890_p2','subtitles':{'danmaku':[{'ext':'xml'}]}}))
    def test_wrong_part_never_enters_processing(self):
        with self.assertRaisesRegex(ValueError,'identity_mismatch'):
            module.exact_part_info(self.job,'unused',self.factory({'id':'BV1234567890_p1','subtitles':{'zh':[{}]}}))

if __name__=='__main__':unittest.main()
