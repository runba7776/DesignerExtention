import type {IconId,Rect,SceneElement,SlideItem} from './contracts';

/** Small, original pictograms made of editable PowerPoint objects. No icon font/network. */
export const iconCatalog:Record<IconId,string>={idea:'アイデア・発想',document:'資料・記録',chart:'グラフ・分析',people:'人・チーム',globe:'地域・国際',shield:'機密・保護',calculator:'数学・計算',clock:'時間・予定',target:'目的・目標',building:'会社・組織',coins:'金額・費用・資産',search:'確認・調査',
  laptop:'PC・作業環境',smartphone:'スマートフォン・モバイル',server:'サーバー・基盤',database:'データベース・保管',cloud:'クラウド',network:'接続・ネットワーク',code:'プログラム・開発',chip:'AI・半導体',
  book:'本・学習',graduation:'学校・進学',flask:'化学・実験',atom:'物理・原子',geometry:'図形・幾何',puzzle:'組み合わせ・パズル',
  leaf:'自然・環境',recycle:'再利用・資源循環',energy:'電力・エネルギー',water:'水・水資源',sun:'太陽・太陽光',heart:'健康・ケア',medical:'医療・病院',accessibility:'利用しやすさ・バリアフリー',
  factory:'製造・工場',tools:'修理・保守',truck:'物流・配送',train:'鉄道・交通',plane:'航空・旅行',shopping:'買い物・小売',package:'製品・荷物',
  message:'対話・発信',mail:'メール・連絡',camera:'写真・撮影',pin:'場所・拠点',calendar:'暦・日付',flag:'節目・開始',balance:'法務・公平',
  person:'人・利用者',family:'家族・世帯',child:'子ども',elder:'高齢者',home:'家・住まい',school:'学校・教育施設',food:'食事・給食',walk:'徒歩・移動・避難',
  warning:'注意・危険',info:'お知らせ・案内',question:'質問・疑問',checklist:'チェックリスト・手順',bell:'通知・呼び出し',megaphone:'広報・呼びかけ',phone:'電話・問い合わせ',pencil:'記入・作成',
  fire:'火災・火気',umbrella:'雨・天候',exit:'出口・避難口',map:'地図・経路',bus:'バス・送迎',car:'車・自動車',bicycle:'自転車',trash:'ごみ・廃棄',key:'鍵・権限',lock:'施錠・保護',star:'重要・評価'};
export const iconGroups:Record<string,IconId[]>={
  '仕事・情報':['idea','document','chart','people','globe','shield','clock','target','building','coins','search'],
  'IT・技術':['laptop','smartphone','server','database','cloud','network','code','chip'],
  '学習・科学':['calculator','book','graduation','flask','atom','geometry','puzzle'],
  '環境・資源':['leaf','recycle','energy','water','sun'],
  '健康・暮らし':['heart','medical','accessibility'],
  '産業・移動':['factory','tools','truck','train','plane','shopping','package'],
  '対話・場所':['message','mail','camera','pin','calendar','flag','balance'],
  '人・暮らし':['person','family','child','elder','home','school','food','walk'],
  '案内・注意':['warning','info','question','checklist','bell','megaphone','phone','pencil','star'],
  '安全・移動':['fire','umbrella','exit','map','bus','car','bicycle','trash','key','lock'],
};
export function resolveItemIcon(item:SlideItem):IconId|undefined {
  if(item.icon==='none')return undefined;
  if(item.icon&&Object.hasOwn(iconCatalog,item.icon))return item.icon;
  // Labels, rather than descriptions, define the category. No status/approval icon.
  const rules:[RegExp,IconId][]=[
    [/機密|保護|セキュリティ|安全|\bsecurity\b/i,'shield'],[/バリアフリー|アクセシビリティ|\baccessibility\b/i,'accessibility'],
    [/データベース|データ保管|\bdatabase\b/i,'database'],[/サーバー|\bserver\b/i,'server'],[/クラウド|\bcloud\b/i,'cloud'],[/ネットワーク|通信網|\bnetwork\b/i,'network'],
    [/スマートフォン|スマホ|モバイル|\bsmartphone\b/i,'smartphone'],[/パソコン|ノートPC|\b(?:PC|laptop)\b/i,'laptop'],[/プログラミング|プログラム|ソフトウェア開発|コード|\b(?:code|programming)\b/i,'code'],[/半導体|人工知能|機械学習|生成AI|\b(?:AI|chip)\b/i,'chip'],
    [/幾何|図形|三角形|正方形|\bgeometry\b/i,'geometry'],[/パズル|組み合わせ|\bpuzzle\b/i,'puzzle'],[/化学|化学実験|\bchemistry\b/i,'flask'],[/物理|原子|電子|\bphysics\b/i,'atom'],[/数学|数式|計算|定理|証明|\b(?:math|equation)\b/i,'calculator'],
    [/学校|大学|進学|卒業|\bgraduation\b/i,'graduation'],[/学習|教育|読書|書籍|\b(?:book|learning)\b/i,'book'],
    [/リサイクル|再利用|資源循環|\brecycl/i,'recycle'],[/太陽|ソーラー|\bsolar\b/i,'sun'],[/水資源|水道|水質|\bwater\b/i,'water'],[/電力|エネルギー|電池|\benergy\b/i,'energy'],[/環境|自然|森林|\becology\b/i,'leaf'],
    [/医療|病院|医師|\bmedical\b/i,'medical'],[/健康|ケア|福祉|\bhealth\b/i,'heart'],[/工場|製造|生産設備|\bfactory\b/i,'factory'],[/修理|保守|メンテナンス|\brepair\b/i,'tools'],
    [/物流|配送|トラック|\blogistics\b/i,'truck'],[/鉄道|電車|\btrain\b/i,'train'],[/航空|飛行機|旅行|\btravel\b/i,'plane'],[/小売|買い物|店舗|\bretail\b/i,'shopping'],[/製品|商品|荷物|\bpackage\b/i,'package'],
    [/避難|防災|非常口|\bexit\b/i,'exit'],[/火災|火気|消火|\bfire\b/i,'fire'],[/注意|危険|警告|\bwarning\b/i,'warning'],[/電話|問い合わせ|問合せ|\bphone\b/i,'phone'],[/家族|世帯|保護者|\bfamily\b/i,'family'],[/子ども|子供|児童|\bchild/i,'child'],[/高齢|シニア|\belder/i,'elder'],[/住まい|住宅|自宅|\bhome\b/i,'home'],[/食事|給食|料理|\bfood\b/i,'food'],[/地図|経路|ルート|\bmap\b/i,'map'],[/バス|送迎|\bbus\b/i,'bus'],[/自転車|\bbicycle\b/i,'bicycle'],[/ごみ|廃棄|\btrash\b/i,'trash'],
    [/メール|\be-?mail\b/i,'mail'],[/写真|撮影|\bcamera\b/i,'camera'],[/対話|会話|コミュニケーション|\bchat\b/i,'message'],[/拠点|所在地|場所|\blocation\b/i,'pin'],[/日付|カレンダー|\bcalendar\b/i,'calendar'],[/節目|開始地点|\bmilestone\b/i,'flag'],[/法務|法律|公平|\blegal\b/i,'balance'],
    [/為替|地域|海外|国際|日本|アジア|北米|欧州|\bglobal\b/i,'globe'],[/売上|収益|利益|費用|経費|原価|資産|資本|現金|財務|金額|自己株式|キャッシュ|\b(?:CF|cash|revenue)\b/i,'coins'],[/時間|日程|予定|スケジュール|\bschedule\b/i,'clock'],[/顧客|人材|チーム|学生|\b(?:people|team)\b/i,'people'],[/資料|文書|記録|\bdocument\b/i,'document'],[/分析|グラフ|統計|\b(?:chart|analysis)\b/i,'chart'],[/企業|会社|組織|\bcompany\b/i,'building'],[/調査|確認|検証|\bsearch\b/i,'search'],[/目標|目的|\b(?:goal|target)\b/i,'target'],[/発想|アイデア|\bidea\b/i,'idea']];
  return rules.find(([pattern])=>pattern.test(item.label))?.[1];
}
export function iconElements(id:IconId,rect:Rect,color:string):SceneElement[] {
  const e:SceneElement[]=[],sx=rect.w/24,sy=rect.h/24,weight=Math.max(1.2,Math.min(sx,sy)*1.4);
  const box=(x:number,y:number,w:number,h:number,shape:'rect'|'roundRect'|'ellipse'='rect',fill='none')=>e.push({kind:'shape',x:rect.x+x*sx,y:rect.y+y*sy,w:w*sx,h:h*sy,shape,fill,stroke:color,strokeWidth:weight});
  const line=(x1:number,y1:number,x2:number,y2:number)=>e.push({kind:'line',x:rect.x+Math.min(x1,x2)*sx,y:rect.y+Math.min(y1,y2)*sy,w:Math.abs(x2-x1)*sx,h:Math.abs(y2-y1)*sy,stroke:color,strokeWidth:weight,flipY:(x2-x1)*(y2-y1)<0});
  const outline=(points:number[][])=>points.forEach((p,i)=>{if(i)line(points[i-1][0],points[i-1][1],p[0],p[1]);});
  switch(id){
    case 'document': box(5,2,14,20,'roundRect');[7,11,15].forEach(y=>line(8,y,16,y));break;
    case 'chart':line(3,3,3,21);line(3,21,22,21);box(6,12,3,7);box(11,7,3,12);box(16,3,3,16);break;
    case 'people':box(8,3,8,8,'ellipse');box(5,13,14,9,'roundRect');box(1,7,4,4,'ellipse');box(19,7,4,4,'ellipse');line(2,14,2,20);line(22,14,22,20);break;
    case 'globe':box(2,2,20,20,'ellipse');box(7,2,10,20,'ellipse');line(2,12,22,12);break;
    case 'shield':line(12,2,21,5);line(21,5,20,15);line(20,15,12,22);line(12,22,4,15);line(4,15,3,5);line(3,5,12,2);box(9,9,6,6,'roundRect');line(12,11,12,13);break;
    case 'calculator':box(4,2,16,20,'roundRect');box(7,5,10,4);[12,17].forEach(y=>[8,15].forEach(x=>box(x,y,1,1,'ellipse',color)));break;
    case 'clock':box(2,2,20,20,'ellipse');line(12,5,12,12);line(12,12,17,15);break;
    case 'target':[20,12,4].forEach(d=>box((24-d)/2,(24-d)/2,d,d,'ellipse'));break;
    case 'building':box(5,2,14,20);[6,11,16].forEach(y=>[8,14].forEach(x=>box(x,y,2,2)));line(2,22,22,22);break;
    case 'coins':[6,10,14].forEach(y=>box(3,y,18,7,'ellipse'));break;
    case 'search':box(2,2,14,14,'ellipse');line(15,15,22,22);break;
    case 'idea':box(6,3,12,12,'ellipse');line(9,14,9,18);line(15,14,15,18);line(9,19,15,19);line(10,22,14,22);line(1,8,3,8);line(21,8,23,8);line(12,0,12,1);break;
    case 'laptop':box(4,3,16,13,'roundRect');line(4,16,1,21);line(1,21,23,21);line(23,21,20,16);line(10,18,14,18);break;
    case 'smartphone':box(6,1,12,22,'roundRect');line(10,4,14,4);line(11,20,13,20);break;
    case 'server':for(const y of [2,9,16]){box(3,y,18,6,'roundRect');box(6,y+2,1,1,'ellipse',color);line(11,y+3,18,y+3);}break;
    case 'database':box(3,2,18,6,'ellipse');line(3,5,3,19);line(21,5,21,19);box(3,10,18,6,'ellipse');box(3,16,18,6,'ellipse');break;
    case 'cloud':outline([[5,20],[2,18],[1,15],[2,12],[5,10],[7,10],[8,6],[11,4],[15,4],[18,6],[19,10],[22,12],[23,15],[22,18],[19,20],[5,20]]);break;
    case 'network':box(9,2,6,6,'roundRect');box(1,16,6,6,'roundRect');box(17,16,6,6,'roundRect');line(12,8,12,12);line(4,12,20,12);line(4,12,4,16);line(20,12,20,16);break;
    case 'code':line(7,6,1,12);line(1,12,7,18);line(17,6,23,12);line(23,12,17,18);line(14,3,10,21);break;
    case 'chip':box(5,5,14,14,'roundRect');box(9,9,6,6);for(const n of [8,12,16]){line(n,1,n,5);line(n,19,n,23);line(1,n,5,n);line(19,n,23,n);}break;
    case 'book':box(2,3,20,18,'roundRect');line(12,3,12,21);for(const y of [8,12,16]){line(5,y,9,y);line(15,y,19,y);}break;
    case 'graduation':line(12,2,23,7);line(23,7,12,12);line(12,12,1,7);line(1,7,12,2);line(5,10,5,17);line(5,17,12,21);line(12,21,19,17);line(19,17,19,10);line(23,7,23,16);break;
    case 'flask':line(8,2,16,2);line(9,2,9,10);line(15,2,15,10);line(9,10,3,21);line(3,21,21,21);line(21,21,15,10);line(6,16,18,16);box(11,17,2,2,'ellipse');break;
    case 'atom':box(2,8,20,8,'ellipse');box(8,2,8,20,'ellipse');box(10,10,4,4,'ellipse',color);box(3,10,3,3,'ellipse',color);box(11,3,3,3,'ellipse',color);break;
    case 'geometry':line(3,21,12,3);line(12,3,21,21);line(21,21,3,21);box(4,16,4,4);line(12,3,12,21);break;
    case 'puzzle':box(2,2,20,20,'roundRect');line(12,2,12,8);box(9,8,6,6,'ellipse');line(12,14,12,22);line(2,12,8,12);line(16,12,22,12);break;
    case 'leaf':box(5,2,16,19,'ellipse');line(3,23,18,6);line(10,15,10,9);line(10,15,17,15);break;
    case 'recycle':line(6,7,12,2);line(12,2,18,7);line(18,7,14,7);line(18,7,18,3);line(21,11,22,18);line(22,18,14,21);line(14,21,16,17);line(14,21,18,23);line(10,21,2,18);line(2,18,4,10);line(4,10,7,13);line(4,10,1,13);break;
    case 'energy':line(13,1,4,13);line(4,13,11,13);line(11,13,10,23);line(10,23,21,9);line(21,9,14,9);line(14,9,13,1);break;
    case 'water':line(12,1,4,13);line(12,1,20,13);box(4,10,16,13,'ellipse');line(9,16,9,19);break;
    case 'sun':box(7,7,10,10,'ellipse');for(const [x,y,dx,dy] of [[12,1,0,3],[12,20,0,3],[1,12,3,0],[20,12,3,0],[3,3,3,3],[18,18,3,3],[3,21,3,-3],[18,6,3,-3]])line(x,y,x+dx,y+dy);break;
    case 'heart':outline([[12,22],[3,13],[1,9],[2,5],[5,3],[8,3],[12,7],[16,3],[19,3],[22,5],[23,9],[21,13],[12,22]]);break;
    case 'medical':box(3,3,18,18,'roundRect');line(12,7,12,17);line(7,12,17,12);break;
    case 'accessibility':box(11,1,5,5,'ellipse');line(13,7,13,15);line(13,10,20,10);line(13,15,19,15);line(19,15,22,21);box(2,11,12,12,'ellipse');break;
    case 'factory':line(2,22,2,10);line(2,10,9,6);line(9,6,9,10);line(9,10,16,6);line(16,6,16,22);line(2,22,22,22);box(17,2,5,20);box(5,15,3,4);box(11,15,3,4);break;
    case 'tools':line(14,2,14,7);line(14,7,19,7);line(19,7,19,2);line(19,2,23,7);line(23,7,19,12);line(19,12,5,23);line(5,23,1,19);line(1,19,12,8);line(12,8,10,4);line(10,4,14,2);box(3,18,2,2,'ellipse');break;
    case 'truck':box(1,5,14,13);box(15,10,8,8);box(4,16,5,5,'ellipse');box(17,16,5,5,'ellipse');line(17,10,17,14);line(17,14,22,14);break;
    case 'train':box(5,1,14,19,'roundRect');box(8,4,8,6);box(7,14,2,2,'ellipse');box(15,14,2,2,'ellipse');line(8,20,5,23);line(16,20,19,23);line(7,22,17,22);break;
    case 'plane':line(11,2,13,2);line(11,2,10,10);line(13,2,14,10);line(10,10,1,14);line(1,14,1,17);line(1,17,10,15);line(14,10,23,14);line(23,14,23,17);line(23,17,14,15);line(10,15,10,20);line(14,15,14,20);line(10,20,7,23);line(7,23,17,23);line(17,23,14,20);break;
    case 'shopping':line(1,3,4,3);line(4,3,7,17);line(7,17,20,17);line(6,6,23,6);line(23,6,20,14);line(20,14,7,14);box(7,19,3,3,'ellipse');box(17,19,3,3,'ellipse');break;
    case 'package':line(12,2,22,7);line(22,7,22,18);line(22,18,12,23);line(12,23,2,18);line(2,18,2,7);line(2,7,12,2);line(2,7,12,12);line(12,12,22,7);line(12,12,12,23);line(7,4,17,9);break;
    case 'message':box(2,2,20,15,'roundRect');line(6,17,6,22);line(6,22,12,17);for(const x of [7,12,17])box(x,9,1,1,'ellipse',color);break;
    case 'mail':box(2,4,20,16,'roundRect');line(2,5,12,13);line(12,13,22,5);line(2,20,8,13);line(16,13,22,20);break;
    case 'camera':box(2,6,20,16,'roundRect');box(8,9,9,9,'ellipse');line(6,6,8,2);line(8,2,16,2);line(16,2,18,6);box(18,9,1,1,'ellipse',color);break;
    case 'pin':box(5,1,14,16,'ellipse');box(10,6,4,4,'ellipse');line(6,12,12,23);line(12,23,18,12);break;
    case 'calendar':box(2,4,20,18,'roundRect');line(2,9,22,9);line(7,1,7,6);line(17,1,17,6);for(const y of [13,17])for(const x of [6,11,16])box(x,y,2,2);break;
    case 'flag':line(4,2,4,23);line(4,3,20,3);line(20,3,16,8);line(16,8,20,13);line(20,13,4,13);line(1,23,8,23);break;
    case 'balance':line(12,2,12,22);line(5,22,19,22);line(3,6,21,6);line(6,6,2,15);line(6,6,10,15);line(2,15,10,15);line(18,6,14,15);line(18,6,22,15);line(14,15,22,15);break;
    case 'person':box(8,2,8,8,'ellipse');box(5,12,14,10,'roundRect');break;
    case 'family':box(3,2,5,5,'ellipse');box(2,9,7,13,'roundRect');box(16,2,5,5,'ellipse');box(15,9,7,13,'roundRect');box(10,10,4,4,'ellipse');box(9.5,15,5,7,'roundRect');break;
    case 'child':box(4,7,7,7,'ellipse');box(3,15,9,7,'roundRect');box(15,1,7,8,'ellipse');outline([[18.5,9],[17,12],[11,16]]);break;
    case 'elder':box(6,2,6,6,'ellipse');outline([[9,9],[8,15],[9,22]]);line(8,15,6,22);line(8.5,12,14,14);line(14,14,15,22);line(14,14,16,13);break;
    case 'home':outline([[2,11],[12,3],[22,11]]);box(5,10,14,12);box(10,15,4,7);break;
    case 'school':outline([[2,11],[12,5],[22,11]]);box(2,11,20,11);line(12,5,12,1);outline([[12,1],[17,2],[12,3]]);box(10,16,4,6);box(4,14,3,3);box(17,14,3,3);break;
    case 'food':outline([[3,12],[21,12],[19,18],[15,21],[9,21],[5,18],[3,12]]);line(13,2,17,11);line(17,2,20,10);break;
    case 'walk':box(12,1,4,4,'ellipse');line(13,6,11,13);line(12,8,16,11);line(12,8,8,11);line(11,13,15,22);line(11,13,7,22);break;
    case 'warning':outline([[12,2],[22,21],[2,21],[12,2]]);line(12,8,12,15);box(11,17,2,2,'ellipse',color);break;
    case 'info':box(2,2,20,20,'ellipse');box(11,6,2,2,'ellipse',color);line(12,10,12,18);break;
    case 'question':box(2,2,20,20,'ellipse');outline([[8.5,9],[9.5,6.5],[12,5.5],[14.5,6.5],[15.5,9],[14,11],[12,12.5],[12,15]]);box(11,17,2,2,'ellipse',color);break;
    case 'checklist':box(4,3,16,19,'roundRect');box(8,1,8,4,'roundRect');for(const y of [10,16]){line(7,y,8.5,y+1.5);line(8.5,y+1.5,11,y-1.5);line(13,y,17,y);}break;
    case 'bell':outline([[6,17],[6,10],[8,5],[12,3],[16,5],[18,10],[18,17],[20,19],[4,19],[6,17]]);box(10.5,19.5,3,3,'ellipse');line(12,1,12,3);break;
    case 'megaphone':outline([[3,9],[13,9],[21,3],[21,21],[13,15],[3,15],[3,9]]);line(13,9,13,15);line(7,15,9,21);break;
    case 'phone':outline([[6,2],[9,2],[11,7],[9,9],[11,13],[15,15],[17,13],[22,15],[22,18],[19,22],[15,21],[9,17],[5,12],[3,7],[3,5],[6,2]]);break;
    case 'pencil':outline([[16,2],[22,8],[9,21],[3,21],[3,15],[16,2]]);line(13,5,19,11);break;
    case 'fire':outline([[12,1],[16,6],[18,11],[17,17],[13,22],[8,21],[5,17],[6,11],[9,8],[10,12],[12,9],[12,1]]);break;
    case 'umbrella':outline([[1,12],[3,7],[7,3],[12,2],[17,3],[21,7],[23,12],[1,12]]);line(12,2,12,19);outline([[12,19],[12,21],[10,22],[8,21]]);break;
    case 'exit':box(3,2,11,20);box(10,11,2,2,'ellipse',color);line(13,12,22,12);line(19,9,22,12);line(19,15,22,12);break;
    case 'map':outline([[2,5],[8,3],[16,6],[22,4],[22,19],[16,21],[8,18],[2,20],[2,5]]);line(8,3,8,18);line(16,6,16,21);break;
    case 'bus':box(3,2,18,17,'roundRect');box(5,5,14,6);box(6,14,2,2,'ellipse',color);box(16,14,2,2,'ellipse',color);box(5,19,4,4,'ellipse');box(15,19,4,4,'ellipse');break;
    case 'car':outline([[2,17],[2,12],[5,11],[8,6],[16,6],[19,11],[22,12],[22,17],[2,17]]);line(5,11,19,11);box(4,15,5,5,'ellipse');box(15,15,5,5,'ellipse');break;
    case 'bicycle':box(1,11,10,10,'ellipse');box(13,11,10,10,'ellipse');outline([[6,16],[10,8],[17,8],[18,16]]);line(6,16,12,16);line(12,16,17,8);line(8,6,12,6);line(10,6,10,8);line(17,8,17,5);line(16,5,19,5);break;
    case 'trash':line(3,6,21,6);outline([[9,6],[9,3],[15,3],[15,6]]);outline([[5,6],[6,22],[18,22],[19,6]]);line(10,10,10,18);line(14,10,14,18);break;
    case 'key':box(2,6,10,10,'ellipse');box(5,9,4,4,'ellipse');line(12,11,22,11);line(18,11,18,15);line(21,11,21,14);break;
    case 'lock':outline([[7,11],[7,7],[9,3],[12,2],[15,3],[17,7],[17,11]]);box(4,11,16,11,'roundRect');box(11,14,2,2,'ellipse',color);line(12,16,12,19);break;
    case 'star':outline(Array.from({length:11},(_,k)=>{const r=k%2?4.5:10.5,a=(-90+36*k)*Math.PI/180;return [12+r*Math.cos(a),12.5+r*Math.sin(a)];}));break;
  }
  return e;
}
/** An icon as SVG, for pages drawn in a browser (the HTML method): the same strokes as its PowerPoint
 * shapes, in the colour of the text around it (currentColor). */
export function iconSvg(id:IconId){
  const n=(v:number)=>Math.round(v*100)/100;
  const parts=iconElements(id,{x:0,y:0,w:24,h:24},'currentColor').map(e=>{
    if(e.kind==='line'){const y1=e.flipY?e.y+e.h:e.y,y2=e.flipY?e.y:e.y+e.h;return `<line x1="${n(e.x)}" y1="${n(y1)}" x2="${n(e.x+e.w)}" y2="${n(y2)}"/>`;}
    if(e.kind!=='shape')return '';
    const fill=e.fill==='none'?'none':'currentColor';
    if(e.shape==='ellipse')return `<ellipse cx="${n(e.x+e.w/2)}" cy="${n(e.y+e.h/2)}" rx="${n(e.w/2)}" ry="${n(e.h/2)}" fill="${fill}"/>`;
    return `<rect x="${n(e.x)}" y="${n(e.y)}" width="${n(e.w)}" height="${n(e.h)}"${e.shape==='roundRect'?` rx="${n(Math.min(e.w,e.h)/6)}"`:''} fill="${fill}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${parts}</svg>`;
}
